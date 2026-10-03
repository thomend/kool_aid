"""Measure how close each edge of the walkable graph is to a public fountain, in DuckDB.

Reads the edges written by build_graph.py and the fountains of Basel (data.bs.ch dataset
100008, "Bade-, Trinkwasser- und Zierbrunnen", points with a name). On first use the dataset
is downloaded straight into the table fountains; later runs reuse that table, so they work
offline. The dataset has no type field, so every fountain counts as a place to drink or cool
down (most of Basel's fountains run with drinking water).

Fountains are rare (about one per 2.4 km of path), so counting them per metre would be zero
almost everywhere. What matters on a hot day is whether one is within reach: each edge is
sampled every metre, as in join_stadtklima_edges.py, and a sample counts when a fountain is
within FOUNTAIN_REACH_M in a straight line. The cost model (scripts/cost_model.py) uses that
share to soften the heat cost.

Creates two tables:
  fountains       one row per fountain (lon/lat in WGS84), written once
  edge_fountains  one row per edge (edge_id = edges.id)
Edge ids change whenever build_graph.py rebuilds the graph, so rerun this script
afterwards with --replace (recomputes edge_fountains only; fountains is left as is).

Usage:
    python scripts/join_fountains_edges.py [--db data/basel.duckdb] [--replace]
"""

import argparse
import io
from pathlib import Path

import duckdb
import numpy as np
import pandas as pd
import requests
import shapely
from pyproj import Transformer

FOUNTAINS_URL = "https://data.bs.ch/api/explore/v2.1/catalog/datasets/100008/exports/csv"
FOUNTAIN_REACH_M = 100.0  # a short detour, about a minute and a half on foot
SAMPLE_STEP_M = 1.0

# WGS84 lon/lat -> Swiss LV95 (metres)
TO_LV95 = Transformer.from_crs("EPSG:4326", "EPSG:2056", always_xy=True)


def load_edges(con):
    return con.execute("SELECT id, wkt FROM edges ORDER BY id").fetchall()


def table_exists(con, name):
    return con.execute(
        "SELECT COUNT(*) FROM information_schema.tables WHERE table_name = ?", [name]
    ).fetchone()[0] > 0


def fetch_fountains():
    """Download the fountain dataset, one row per fountain with lon/lat."""
    print("Downloading fountains from data.bs.ch ...")
    resp = requests.get(FOUNTAINS_URL, timeout=300)
    resp.raise_for_status()
    df = pd.read_csv(io.BytesIO(resp.content), sep=";", encoding="utf-8-sig")
    df = df.dropna(subset=["geo_point_2d"])
    # geo_point_2d is "lat, lon"
    latlon = df["geo_point_2d"].str.split(",", expand=True).astype(float)
    return pd.DataFrame({
        "fountain_id": np.arange(1, len(df) + 1),
        "name": df["name"],
        "description": df["desc"],
        "lon": latlon[1],
        "lat": latlon[0],
    })


def write_fountains(con, fountains_df):
    con.execute("""
        CREATE TABLE fountains (
            fountain_id INTEGER PRIMARY KEY,  -- row number in the dataset
            name VARCHAR,                     -- e.g. Sevogel-Brunnen
            description VARCHAR,              -- location and photo credit
            lon DOUBLE,                       -- WGS84
            lat DOUBLE
        )
    """)
    con.execute("INSERT INTO fountains BY NAME SELECT * FROM fountains_df")


def load_fountains(con):
    """Fountain ids, names and locations in LV95 as shapely points."""
    ids, names, lon, lat = zip(*con.execute(
        "SELECT fountain_id, name, lon, lat FROM fountains ORDER BY fountain_id"
    ).fetchall())
    points = shapely.points(*TO_LV95.transform(np.array(lon), np.array(lat)))
    return np.array(ids), np.array(names, dtype=object), points


def edge_lines(edges):
    """Edge geometries in LV95."""
    lines = []
    for _, wkt in edges:
        lonlat = shapely.get_coordinates(shapely.from_wkt(wkt))
        lines.append(shapely.LineString(np.column_stack(TO_LV95.transform(lonlat[:, 0], lonlat[:, 1]))))
    return lines


def fountain_share(lines, fountain_index):
    """Share of each line's length within FOUNTAIN_REACH_M of a fountain, from 1 m samples."""
    edge_of, points = [], []
    for i, line in enumerate(lines):
        # midpoints of equal-length pieces, at least one (the middle) for very short edges
        n = max(1, int(np.ceil(line.length / SAMPLE_STEP_M)))
        points.append(shapely.line_interpolate_point(line, (np.arange(n) + 0.5) * line.length / n))
        edge_of.append(np.full(n, i))
    points, edge_of = np.concatenate(points), np.concatenate(edge_of)
    near = np.zeros(len(points), bool)
    near[fountain_index.query(points, predicate="dwithin", distance=FOUNTAIN_REACH_M)[0]] = True
    return np.bincount(edge_of, near, len(lines)) / np.bincount(edge_of, minlength=len(lines))


def build_table(edges, fountain_ids, fountain_points):
    lines = edge_lines(edges)
    fountain_index = shapely.STRtree(fountain_points)
    # nearest fountain to each edge (to any point of it)
    edge_idx, fountain_idx = fountain_index.query_nearest(lines, all_matches=False)
    nearest_id = np.full(len(edges), -1)
    nearest_id[edge_idx] = fountain_ids[fountain_idx]
    distance = np.full(len(edges), np.nan)
    distance[edge_idx] = shapely.distance(np.array(lines, dtype=object)[edge_idx],
                                          fountain_points[fountain_idx])
    return pd.DataFrame({
        "edge_id": [e[0] for e in edges],
        "nearest_fountain_id": nearest_id,
        "nearest_fountain_m": distance,
        "fountain_share": fountain_share(lines, fountain_index),
    })


def write_db(con, table_df):
    con.execute("DROP TABLE IF EXISTS edge_fountains")
    # No REFERENCES edges (id): it would block the DROP TABLE edges in build_graph.py
    con.execute("""
        CREATE TABLE edge_fountains (
            edge_id INTEGER PRIMARY KEY,   -- edges.id
            nearest_fountain_id INTEGER,   -- fountains.fountain_id
            nearest_fountain_m DOUBLE,     -- straight-line distance from the edge to it
            fountain_share DOUBLE          -- 0..1, share of the length within FOUNTAIN_REACH_M of a fountain
        )
    """)
    con.execute("INSERT INTO edge_fountains BY NAME SELECT * FROM table_df")


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--db", type=Path, default=Path("data/basel.duckdb"))
    parser.add_argument("--replace", action="store_true",
                        help="recompute edge_fountains if it already exists")
    args = parser.parse_args()

    con = duckdb.connect(str(args.db))
    if table_exists(con, "edge_fountains") and not args.replace:
        raise SystemExit(
            "Table edge_fountains already exists. Rerun with --replace to recompute it "
            "(needed after build_graph.py rebuilt the edges)."
        )
    if not table_exists(con, "fountains"):
        write_fountains(con, fetch_fountains())
    fountain_ids, _, fountain_points = load_fountains(con)
    table_df = build_table(load_edges(con), fountain_ids, fountain_points)
    write_db(con, table_df)
    con.close()

    share, distance = table_df["fountain_share"], table_df["nearest_fountain_m"]
    print(
        f"Wrote {len(table_df)} edges to edge_fountains in {args.db} from {len(fountain_points)} "
        f"fountains ({(share > 0).sum()} edges partly within {FOUNTAIN_REACH_M:.0f} m of one, "
        f"mean share {share.mean():.2f}; nearest fountain median {distance.median():.0f} m, "
        f"max {distance.max():.0f} m)"
    )


if __name__ == "__main__":
    main()
