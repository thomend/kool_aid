"""Count the trees of the Basel-Stadt tree cadastre near each edge of the walkable graph in DuckDB.

Reads the edges written by build_graph.py and the Baumkataster Basel-Stadt (data.bs.ch dataset
100052, public trees as points). On first use the cadastre is downloaded straight into the
table trees; later runs reuse that table, so they work offline.
A tree counts for every edge within BUFFER_M of it, so a tree at a crossing counts for each
of the edges meeting there. The trees cover public ground only (streets, parks, schools),
not private gardens.

Creates two tables:
  trees       one row per tree of the cadastre (lon/lat in WGS84), written once
  edge_trees  one row per edge (edge_id = edges.id)
Edge ids change whenever build_graph.py rebuilds the graph, so rerun this script
afterwards with --replace (recomputes edge_trees only; trees is left as is).

Usage:
    python scripts/join_trees_edges.py [--db data/basel.duckdb] [--replace]
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

TREES_URL = "https://data.bs.ch/api/explore/v2.1/catalog/datasets/100052/exports/csv"
BUFFER_M = 15.0  # roughly a crown radius plus the sidewalk

# WGS84 lon/lat -> Swiss LV95 (metres)
TO_LV95 = Transformer.from_crs("EPSG:4326", "EPSG:2056", always_xy=True)


def load_edges(con):
    return con.execute("SELECT id, wkt, length_m FROM edges ORDER BY id").fetchall()


def table_exists(con, name):
    return con.execute(
        "SELECT COUNT(*) FROM information_schema.tables WHERE table_name = ?", [name]
    ).fetchone()[0] > 0


def fetch_trees():
    """Download the tree cadastre, one row per tree with lon/lat."""
    print("Downloading tree cadastre from data.bs.ch ...")
    resp = requests.get(TREES_URL, timeout=300)
    resp.raise_for_status()
    df = pd.read_csv(io.BytesIO(resp.content), sep=";", encoding="utf-8-sig")
    df = df.dropna(subset=["geo_point_2d"])
    # geo_point_2d is "lat, lon"
    latlon = df["geo_point_2d"].str.split(",", expand=True).astype(float)
    return pd.DataFrame({
        "tree_id": df["ba_baumnr"],
        "species_latin": df["baumart_lateinisch"],
        "species_german": df["baumart_deutsch"],
        "tree_group": df["ba_gruppe"],
        "street": df["ba_strasse"],
        "age_years": df["ba_baumalter"].astype("Int64"),
        "protection": df["ba_schutzstatus"],
        "lon": latlon[1],
        "lat": latlon[0],
    })


def write_trees(con, trees_df):
    con.execute("""
        CREATE TABLE trees (
            tree_id VARCHAR PRIMARY KEY,  -- ba_baumnr, e.g. BS039074
            species_latin VARCHAR,
            species_german VARCHAR,
            tree_group VARCHAR,           -- e.g. Strassenbäume, Öffentliche Grünflächen
            street VARCHAR,
            age_years INTEGER,
            protection VARCHAR,           -- ba_schutzstatus
            lon DOUBLE,                   -- WGS84
            lat DOUBLE
        )
    """)
    con.execute("INSERT INTO trees BY NAME SELECT * FROM trees_df")


def load_trees(con):
    """Tree locations in LV95 as shapely points."""
    lon, lat = np.array(con.execute("SELECT lon, lat FROM trees").fetchall()).T
    return shapely.points(*TO_LV95.transform(lon, lat))


def edge_lines(edges):
    """Edge geometries in LV95."""
    lines = []
    for _, wkt, _ in edges:
        lonlat = shapely.get_coordinates(shapely.from_wkt(wkt))
        lines.append(shapely.LineString(np.column_stack(TO_LV95.transform(lonlat[:, 0], lonlat[:, 1]))))
    return lines


def build_table(edges, trees):
    # pairs[0] indexes the edges, pairs[1] the trees within BUFFER_M of that edge
    pairs = shapely.STRtree(trees).query(edge_lines(edges), predicate="dwithin", distance=BUFFER_M)
    counts = np.bincount(pairs[0], minlength=len(edges))
    length = np.array([e[2] for e in edges], dtype=float)
    with np.errstate(divide="ignore", invalid="ignore"):
        density = np.where(length > 0, counts / length * 100, np.nan)
    return pd.DataFrame({
        "edge_id": [e[0] for e in edges],
        "tree_count": counts,
        "trees_per_100m": density,
    })


def write_db(con, table_df):
    con.execute("DROP TABLE IF EXISTS edge_trees")
    # No REFERENCES edges (id): it would block the DROP TABLE edges in build_graph.py
    con.execute("""
        CREATE TABLE edge_trees (
            edge_id INTEGER PRIMARY KEY,  -- edges.id
            tree_count INTEGER,           -- cadastre trees within BUFFER_M of the edge
            trees_per_100m DOUBLE         -- tree_count per 100 m of edge length
        )
    """)
    con.execute("INSERT INTO edge_trees BY NAME SELECT * FROM table_df")


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--db", type=Path, default=Path("data/basel.duckdb"))
    parser.add_argument("--replace", action="store_true",
                        help="recompute edge_trees if it already exists")
    args = parser.parse_args()

    con = duckdb.connect(str(args.db))
    if table_exists(con, "edge_trees") and not args.replace:
        raise SystemExit(
            "Table edge_trees already exists. Rerun with --replace to recompute it "
            "(needed after build_graph.py rebuilt the edges)."
        )
    if not table_exists(con, "trees"):
        write_trees(con, fetch_trees())
    trees = load_trees(con)
    table_df = build_table(load_edges(con), trees)
    write_db(con, table_df)
    con.close()

    density = table_df["trees_per_100m"]
    print(
        f"Wrote {len(table_df)} edges to edge_trees in {args.db} from {len(trees)} trees "
        f"({(table_df['tree_count'] > 0).sum()} edges with trees within {BUFFER_M:.0f} m; "
        f"trees per 100 m min/mean/max {density.min():.1f}/{density.mean():.1f}/{density.max():.1f})"
    )


if __name__ == "__main__":
    main()
