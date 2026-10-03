"""Join the Stadtklima PET rasters onto the edges of the walkable graph in DuckDB.

Reads the edges written by build_graph.py and the Stadtklimaanalyse Basel-Stadt rasters
(Humanbioklimatische Situation, PET in degrees C at 14:00, 10 m cells, LV95) for today and 2030.
Each edge is sampled every metre along its geometry, so the mean is length-weighted;
NoData cells (e.g. buildings) and points outside the raster are ignored. The squared
heat excess the cost model needs (cost_model.heat_excess_sq) is averaged over the
same samples.

Creates one table, edge_stadtklima, one row per edge (edge_id = edges.id).
Edge ids change whenever build_graph.py rebuilds the graph, so rerun this script
afterwards with --replace.

Usage:
    python scripts/join_stadtklima_edges.py [--db data/basel.duckdb] [--replace]
"""

import argparse
from pathlib import Path

import duckdb
import numpy as np
import pandas as pd
import rasterio
import shapely
from pyproj import Transformer

from cost_model import heat_excess_sq

# The GeoTIFFs carry no CRS; per their .tfw files and metadata they are Swiss LV95
RASTERS = {
    "pet_mean_c": Path("data/KL_Stadtklima_KGDM_V1_1/HumanbioklimSituation.tif"),
    "pet_2030_mean_c": Path("data/KL_Stadtklima_KGDM_V1_0/HumanbioklimSituation_2030.tif"),
}
SAMPLE_STEP_M = 1.0

# WGS84 lon/lat -> Swiss LV95 (metres)
TO_LV95 = Transformer.from_crs("EPSG:4326", "EPSG:2056", always_xy=True)


def load_edges(con):
    return con.execute("SELECT id, wkt FROM edges ORDER BY id").fetchall()


def sample_points(edges):
    """Points every SAMPLE_STEP_M along each edge in LV95, as (edge_id, x, y) arrays."""
    ids, xs, ys = [], [], []
    for edge_id, wkt in edges:
        lonlat = shapely.get_coordinates(shapely.from_wkt(wkt))
        line = shapely.LineString(np.column_stack(TO_LV95.transform(lonlat[:, 0], lonlat[:, 1])))
        # midpoints of equal-length pieces, at least one (the middle) for very short edges
        n = max(1, int(np.ceil(line.length / SAMPLE_STEP_M)))
        dist = (np.arange(n) + 0.5) * line.length / n
        coords = shapely.get_coordinates(shapely.line_interpolate_point(line, dist))
        ids.append(np.full(n, edge_id))
        xs.append(coords[:, 0])
        ys.append(coords[:, 1])
    return np.concatenate(ids), np.concatenate(xs), np.concatenate(ys)


def raster_values(path, xs, ys):
    """Raster value at each point, NaN for NoData or outside the raster."""
    with rasterio.open(path) as src:
        band = src.read(1)
        nodata = src.nodata
        cols, rows = ~src.transform * (xs, ys)
    rows = np.floor(rows).astype(int)
    cols = np.floor(cols).astype(int)
    inside = (rows >= 0) & (rows < band.shape[0]) & (cols >= 0) & (cols < band.shape[1])
    values = np.full(len(xs), np.nan)
    values[inside] = band[rows[inside], cols[inside]]
    values[values == nodata] = np.nan
    return values


def build_table(edges):
    edge_ids, xs, ys = sample_points(edges)
    samples = pd.DataFrame({"edge_id": edge_ids})
    for column, path in RASTERS.items():
        samples[column] = raster_values(path, xs, ys)
    samples["heat_excess_sq_mean"] = heat_excess_sq(samples["pet_mean_c"])
    # mean() skips NaN; edges without any valid sample end up NULL
    table = samples.groupby("edge_id", as_index=False).mean()
    return pd.DataFrame({"edge_id": [e[0] for e in edges]}).merge(table, on="edge_id", how="left")


def write_db(con, table_df, replace):
    exists = con.execute(
        "SELECT COUNT(*) FROM information_schema.tables WHERE table_name = 'edge_stadtklima'"
    ).fetchone()[0]
    if exists and not replace:
        raise SystemExit(
            "Table edge_stadtklima already exists. Rerun with --replace to recompute it "
            "(needed after build_graph.py rebuilt the edges)."
        )
    con.execute("DROP TABLE IF EXISTS edge_stadtklima")
    # No REFERENCES edges (id): it would block the DROP TABLE edges in build_graph.py
    con.execute("""
        CREATE TABLE edge_stadtklima (
            edge_id INTEGER PRIMARY KEY,  -- edges.id
            pet_mean_c DOUBLE,            -- PET at 14:00 today, length-weighted mean, degrees C
            pet_2030_mean_c DOUBLE,       -- PET at 14:00, scenario 2030
            heat_excess_sq_mean DOUBLE    -- cost_model.heat_excess_sq of today's PET, length-weighted mean
        )
    """)
    con.execute("INSERT INTO edge_stadtklima BY NAME SELECT * FROM table_df")


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--db", type=Path, default=Path("data/basel.duckdb"))
    parser.add_argument("--replace", action="store_true",
                        help="recompute edge_stadtklima if it already exists")
    args = parser.parse_args()

    con = duckdb.connect(str(args.db))
    table_df = build_table(load_edges(con))
    write_db(con, table_df, args.replace)
    con.close()

    pet = table_df["pet_mean_c"]
    print(
        f"Wrote {len(table_df)} edges to edge_stadtklima in {args.db} "
        f"({pet.isna().sum()} without raster values; "
        f"PET today min/mean/max {pet.min():.1f}/{pet.mean():.1f}/{pet.max():.1f} C)"
    )


if __name__ == "__main__":
    main()
