"""Count the trees of the Basel-Stadt tree cadastre near each edge of the walkable graph in DuckDB.

Reads the edges written by build_graph.py and the Baumkataster Basel-Stadt (data.bs.ch dataset
100052, public trees as points), downloading the CSV to data/baumkataster/ on first use.
A tree counts for every edge within BUFFER_M of it, so a tree at a crossing counts for each
of the edges meeting there. The trees cover public ground only (streets, parks, schools),
not private gardens.

Creates one table, edge_trees, one row per edge (edge_id = edges.id).
Edge ids change whenever build_graph.py rebuilds the graph, so rerun this script
afterwards with --replace.

Usage:
    python scripts/join_trees_edges.py [--db data/basel.duckdb] [--replace]
"""

import argparse
from pathlib import Path

import duckdb
import numpy as np
import pandas as pd
import requests
import shapely
from pyproj import Transformer

TREES_CSV = Path("data/baumkataster/100052.csv")
TREES_URL = "https://data.bs.ch/api/explore/v2.1/catalog/datasets/100052/exports/csv"
BUFFER_M = 15.0  # roughly a crown radius plus the sidewalk

# WGS84 lon/lat -> Swiss LV95 (metres)
TO_LV95 = Transformer.from_crs("EPSG:4326", "EPSG:2056", always_xy=True)


def load_edges(con):
    return con.execute("SELECT id, wkt, length_m FROM edges ORDER BY id").fetchall()


def load_trees():
    """Tree locations in LV95 as shapely points, downloading the cadastre if needed."""
    if not TREES_CSV.exists():
        print(f"Downloading tree cadastre to {TREES_CSV} ...")
        resp = requests.get(TREES_URL, timeout=300)
        resp.raise_for_status()
        TREES_CSV.parent.mkdir(parents=True, exist_ok=True)
        TREES_CSV.write_bytes(resp.content)
    df = pd.read_csv(TREES_CSV, sep=";", usecols=["geo_point_2d"], encoding="utf-8-sig")
    # geo_point_2d is "lat, lon"
    latlon = df["geo_point_2d"].dropna().str.split(",", expand=True).astype(float)
    x, y = TO_LV95.transform(latlon[1].to_numpy(), latlon[0].to_numpy())
    return shapely.points(x, y)


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


def write_db(con, table_df, replace):
    exists = con.execute(
        "SELECT COUNT(*) FROM information_schema.tables WHERE table_name = 'edge_trees'"
    ).fetchone()[0]
    if exists and not replace:
        raise SystemExit(
            "Table edge_trees already exists. Rerun with --replace to recompute it "
            "(needed after build_graph.py rebuilt the edges)."
        )
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

    trees = load_trees()
    con = duckdb.connect(str(args.db))
    table_df = build_table(load_edges(con), trees)
    write_db(con, table_df, args.replace)
    con.close()

    density = table_df["trees_per_100m"]
    print(
        f"Wrote {len(table_df)} edges to edge_trees in {args.db} from {len(trees)} trees "
        f"({(table_df['tree_count'] > 0).sum()} edges with trees within {BUFFER_M:.0f} m; "
        f"trees per 100 m min/mean/max {density.min():.1f}/{density.mean():.1f}/{density.max():.1f})"
    )


if __name__ == "__main__":
    main()
