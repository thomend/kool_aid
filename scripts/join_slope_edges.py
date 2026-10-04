"""Measure the gradient of each edge of the walkable graph from the swissALTI3D terrain model.

Reads the edges written by build_graph.py and swisstopo's swissALTI3D (2 m digital terrain
model, LV95/LN02). The tiles covering Basel are downloaded once into data/cache/ (not in git).
Each edge is sampled every SAMPLE_STEP_M; uphill and downhill count the same.

The terrain model has no bridges or tunnels: on them (connected OSM ways tagged bridge or
tunnel, merged into one structure) and within STRUCTURE_SNAP_M of their ends, the elevation
is interpolated between the structure's two ends; a bridge end is the highest terrain within
BRIDGE_END_M (the top of the bank). Streets passing under or over a structure keep the terrain. The tags are fetched from Overpass once into the table
way_structures; later runs work offline.

The cost model (scripts/cost_model.py) uses slope_excess: the mean of
exp(TOBLER_STEEPNESS * |grade|) - 1 along the edge, Tobler's hiking function made symmetric,
i.e. how much longer walking takes than on the flat (5 %: +19 %, 10 %: +42 %).

Creates two tables:
  way_structures  osm_id, structure (bridge or tunnel), written once
  edge_slope      one row per edge (edge_id = edges.id)
Edge ids change whenever build_graph.py rebuilds the graph, so rerun this script
afterwards with --replace.

Usage:
    python scripts/join_slope_edges.py [--db data/basel.duckdb] [--replace]
"""

import argparse
from pathlib import Path

import duckdb
import numpy as np
import pandas as pd
import rasterio
import requests
import shapely
from pyproj import Transformer
from rasterio.merge import merge

from cost_model import MAX_GRADE, TOBLER_STEEPNESS
from fetch_paths import run_overpass

STAC_ITEMS = "https://data.geo.admin.ch/api/stac/v0.9/collections/ch.swisstopo.swissalti3d/items"
CACHE = Path("data/cache/swissalti3d")
RESOLUTION_M = 2.0
SAMPLE_STEP_M = 5.0  # gradient over 5 m pieces, so the terrain model's noise doesn't add up
STRUCTURE_SNAP_M = 3.0  # structure edges, and points this close to a structure's end, take its height
BRIDGE_END_M = 10.0  # a bridge starts at the highest terrain this close to its end

STRUCTURES_QUERY = """
[out:json][timeout:120];
area["name"="Basel"]["boundary"="administrative"]["admin_level"="8"]->.basel;
(way["highway"]["bridge"](area.basel); way["highway"]["tunnel"](area.basel););
out tags;
"""

TO_LV95 = Transformer.from_crs("EPSG:4326", "EPSG:2056", always_xy=True)


def table_exists(con, name):
    return con.execute(
        "SELECT COUNT(*) FROM information_schema.tables WHERE table_name = ?", [name]
    ).fetchone()[0] > 0


def fetch_structures():
    """OSM way ids of bridges and tunnels (tag values other than "no")."""
    print("Fetching bridges and tunnels from Overpass ...")
    rows = []
    for el in run_overpass(STRUCTURES_QUERY):
        tags = el.get("tags", {})
        for kind in ("bridge", "tunnel"):
            if tags.get(kind, "no") != "no":
                rows.append({"osm_id": el["id"], "structure": kind})
                break
    return pd.DataFrame(rows).drop_duplicates("osm_id")


def write_structures(con, df):
    con.execute("""
        CREATE TABLE way_structures (
            osm_id BIGINT PRIMARY KEY,  -- paths.osm_id / edges.way_osm_id
            structure VARCHAR           -- bridge or tunnel
        )
    """)
    con.execute("INSERT INTO way_structures BY NAME SELECT * FROM df")


def download_tiles(bounds):
    """Paths of the newest 2 m swissALTI3D tiles covering bounds (LV95), downloaded once."""
    lon0, lat0 = TO_LV95.transform(*bounds[0], direction="INVERSE")
    lon1, lat1 = TO_LV95.transform(*bounds[1], direction="INVERSE")
    newest = {}  # tile "E-N" -> (year, url)
    url, params = STAC_ITEMS, {"bbox": f"{lon0},{lat0},{lon1},{lat1}", "limit": 100}
    while url:
        page = requests.get(url, params=params, timeout=60).json()
        for item in page["features"]:
            _, year, tile = item["id"].split("_")
            for asset in item["assets"].values():
                if asset.get("eo:gsd") == RESOLUTION_M and asset["href"].endswith(".tif"):
                    if tile not in newest or year > newest[tile][0]:
                        newest[tile] = (year, asset["href"])
        url = next((link["href"] for link in page["links"] if link["rel"] == "next"), None)
        params = None  # the next link carries them
    CACHE.mkdir(parents=True, exist_ok=True)
    paths = []
    for _, href in newest.values():
        path = CACHE / href.rsplit("/", 1)[1]
        if not path.exists():
            print(f"Downloading {path.name} ...")
            path.write_bytes(requests.get(href, timeout=120).content)
        paths.append(path)
    return paths


def terrain(paths):
    """Bilinear sampler of the merged tiles: LV95 (n, 2) -> elevation, NaN outside."""
    sources = [rasterio.open(p) for p in paths]
    grid, transform = merge(sources)
    nodata = sources[0].nodata
    for s in sources:
        s.close()
    z = grid[0].astype(float)
    if nodata is not None:
        z[z == nodata] = np.nan
    inverse = ~transform

    def sample(points):
        cols, rows = inverse * (points[:, 0], points[:, 1])
        # pixel centres sit at +0.5
        c, r = np.asarray(cols) - 0.5, np.asarray(rows) - 0.5
        c0, r0 = np.floor(c).astype(int), np.floor(r).astype(int)
        fc, fr = c - c0, r - r0
        inside = (c0 >= 0) & (r0 >= 0) & (c0 < z.shape[1] - 1) & (r0 < z.shape[0] - 1)
        out = np.full(len(points), np.nan)
        c0, r0, fc, fr = c0[inside], r0[inside], fc[inside], fr[inside]
        out[inside] = (
            z[r0, c0] * (1 - fc) * (1 - fr) + z[r0, c0 + 1] * fc * (1 - fr)
            + z[r0 + 1, c0] * (1 - fc) * fr + z[r0 + 1, c0 + 1] * fc * fr
        )
        return out

    return sample


def lv95_line(wkt):
    lonlat = shapely.get_coordinates(shapely.from_wkt(wkt))
    return shapely.LineString(np.column_stack(TO_LV95.transform(lonlat[:, 0], lonlat[:, 1])))


def structure_lines(con, kind):
    """Bridges or tunnels as lines (LV95), connected OSM ways merged into one."""
    wkts = [w for (w,) in con.execute("""
        SELECT p.wkt FROM paths p JOIN way_structures s ON s.osm_id = p.osm_id
        WHERE s.structure = ?
    """, [kind]).fetchall()]
    if not wkts:
        return []
    merged = shapely.line_merge(shapely.union_all([lv95_line(w) for w in wkts]))
    return list(shapely.get_parts(merged))


def structure_heights(lines, elevation, kind):
    """(line, height at start, height at end) per bridge or tunnel."""
    ring = np.array([(np.cos(a), np.sin(a)) for a in np.linspace(0, 2 * np.pi, 12, endpoint=False)])
    disc = np.vstack([[0, 0], ring * BRIDGE_END_M / 2, ring * BRIDGE_END_M])
    out = []
    for line in lines:
        ends = shapely.get_coordinates(line)[[0, -1]]
        if kind == "bridge":  # the road runs at the top of the bank
            z = [np.nanmax(elevation(end + disc)) for end in ends]
        else:  # a tunnel portal sits on the terrain
            z = elevation(ends)
        out.append((line, z[0], z[1]))
    return out


def build_table(edges, structures, elevation):
    """Mean |grade|, steepest piece and slope_excess per edge."""
    index = shapely.STRtree([line for line, _, _ in structures])
    ends = shapely.STRtree(shapely.points(np.array([shapely.get_coordinates(line)[[0, -1]] for line, _, _ in structures]).reshape(-1, 2)))
    rows = []
    for edge_id, wkt, structure in edges:
        line = lv95_line(wkt)
        n = max(1, int(np.ceil(line.length / SAMPLE_STEP_M)))
        points = shapely.get_coordinates(
            shapely.line_interpolate_point(line, np.linspace(0, line.length, n + 1))
        )
        z = elevation(points)
        pts = shapely.points(points)
        # the nearest structure only: parallel bridge ways can differ in height
        if structure:  # on a bridge or tunnel: every point
            on, near = index.query_nearest(pts, max_distance=STRUCTURE_SNAP_M, all_matches=False)
        else:  # elsewhere only where the edge joins a structure's end
            on, end = ends.query_nearest(pts, max_distance=STRUCTURE_SNAP_M, all_matches=False)
            near = end // 2
        # straight between the structure's ends
        for i, k in zip(on, near, strict=True):
            way, z0, z1 = structures[k]
            share = shapely.line_locate_point(way, pts[i], normalized=True)
            z[i] = z0 + share * (z1 - z0)
        piece = line.length / n
        grade = np.minimum(np.abs(np.diff(z)) / max(piece, 1e-6), MAX_GRADE)
        grade = np.nan_to_num(grade)  # outside the terrain model: flat
        rows.append({
            "edge_id": edge_id,
            "grade_mean": float(grade.mean()),
            "grade_max": float(grade.max()),
            "slope_excess": float(np.mean(np.exp(TOBLER_STEEPNESS * grade) - 1)),
            "structure": structure,
        })
    return pd.DataFrame(rows)


def write_db(con, df):
    con.execute("DROP TABLE IF EXISTS edge_slope")
    # No REFERENCES edges (id): it would block the DROP TABLE edges in build_graph.py
    con.execute("""
        CREATE TABLE edge_slope (
            edge_id INTEGER PRIMARY KEY,  -- edges.id
            grade_mean DOUBLE,            -- mean |gradient| (0.05 = 5 %), capped at MAX_GRADE
            grade_max DOUBLE,             -- steepest SAMPLE_STEP_M piece
            slope_excess DOUBLE,          -- mean of exp(TOBLER_STEEPNESS * |grade|) - 1
            structure VARCHAR             -- bridge or tunnel (OSM tag of the edge's way), else NULL
        )
    """)
    con.execute("INSERT INTO edge_slope BY NAME SELECT * FROM df")


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--db", type=Path, default=Path("data/basel.duckdb"))
    parser.add_argument("--replace", action="store_true",
                        help="recompute edge_slope if it already exists")
    args = parser.parse_args()

    con = duckdb.connect(str(args.db))
    if table_exists(con, "edge_slope") and not args.replace:
        raise SystemExit(
            "Table edge_slope already exists. Rerun with --replace to recompute it "
            "(needed after build_graph.py rebuilt the edges)."
        )
    if not table_exists(con, "way_structures"):
        write_structures(con, fetch_structures())
    edges = con.execute("""
        SELECT e.id, e.wkt, s.structure
        FROM edges e LEFT JOIN way_structures s ON s.osm_id = e.way_osm_id
        ORDER BY e.id
    """).fetchall()
    nodes = np.array(con.execute("SELECT x, y FROM nodes").fetchall())
    bounds = np.array([nodes.min(axis=0) - 100, nodes.max(axis=0) + 100])
    elevation = terrain(download_tiles(bounds))
    structures = [
        s for kind in ("bridge", "tunnel")
        for s in structure_heights(structure_lines(con, kind), elevation, kind)
    ]
    df = build_table(edges, structures, elevation)
    write_db(con, df)
    con.close()

    print(
        f"Wrote {len(df)} edges to edge_slope in {args.db} "
        f"({(df['structure'].notna()).sum()} on bridges/tunnels; mean gradient "
        f"{df['grade_mean'].mean():.1%}, {(df['grade_mean'] > 0.05).sum()} edges steeper than 5 %)"
    )


if __name__ == "__main__":
    main()
