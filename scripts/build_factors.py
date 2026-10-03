"""Write the cost model (see cost_model.py) into DuckDB.

Creates:
  edge_factors    one row per edge: edge_id, length_m, and the raw value
                  columns the factors read (pet_c, pet_2030_c)
  factors         factor registry, variants as JSON
  cost_functions  predefined cost functions, factor settings as JSON

Needs edges (build_graph.py) and edge_stadtklima (join_stadtklima_edges.py).

Usage:
    python scripts/build_factors.py [--db data/basel.duckdb]
"""

import argparse
import json
from pathlib import Path

import duckdb

from cost_model import COST_FUNCTIONS, DEFAULT_COST_FUNCTION, FACTORS


def check_definitions():
    factors = {f.key: f for f in FACTORS}
    for fn in COST_FUNCTIONS:
        for key, (_, variant) in fn.factors.items():
            if key not in factors:
                raise ValueError(f"cost function {fn.id!r} uses unknown factor {key!r}")
            if factors[key].variants and variant not in {v.key for v in factors[key].variants}:
                raise ValueError(f"cost function {fn.id!r}: {key!r} has no variant {variant!r}")
    if DEFAULT_COST_FUNCTION not in {fn.id for fn in COST_FUNCTIONS}:
        raise ValueError(f"default cost function {DEFAULT_COST_FUNCTION!r} is not defined")


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--db", type=Path, default=Path("data/basel.duckdb"))
    args = parser.parse_args()
    check_definitions()

    con = duckdb.connect(str(args.db))
    con.execute("""
        CREATE OR REPLACE TABLE edge_factors AS
        SELECT e.id AS edge_id,
               e.length_m,
               s.pet_mean_c AS pet_c,          -- PET today, NULL outside the raster
               s.pet_2030_mean_c AS pet_2030_c -- PET 2030 scenario
        FROM edges e
        LEFT JOIN edge_stadtklima s ON s.edge_id = e.id
        ORDER BY e.id
    """)

    con.execute("""
        CREATE OR REPLACE TABLE factors (
            key VARCHAR PRIMARY KEY,
            label VARCHAR,
            kind VARCHAR,            -- static | editable
            unit VARCHAR,
            description VARCHAR,
            variants JSON,           -- [{key, label, column}], empty for constant factors
            transform VARCHAR,       -- constant | above_threshold
            threshold DOUBLE,
            default_weight DOUBLE,
            weight_max DOUBLE,
            position INTEGER
        )
    """)
    con.executemany(
        "INSERT INTO factors VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
            (
                f.key, f.label, f.kind, f.unit, f.description,
                json.dumps([v.__dict__ for v in f.variants]),
                f.transform, f.threshold, f.default_weight, f.weight_max, i,
            )
            for i, f in enumerate(FACTORS)
        ],
    )

    con.execute("""
        CREATE OR REPLACE TABLE cost_functions (
            id VARCHAR PRIMARY KEY,
            label VARCHAR,
            description VARCHAR,
            factors JSON,            -- {factor_key: {weight, variant}}; missing = off
            is_default BOOLEAN,
            position INTEGER
        )
    """)
    con.executemany(
        "INSERT INTO cost_functions VALUES (?, ?, ?, ?, ?, ?)",
        [
            (
                fn.id, fn.label, fn.description,
                json.dumps({k: {"weight": w, "variant": v} for k, (w, v) in fn.factors.items()}),
                fn.id == DEFAULT_COST_FUNCTION, i,
            )
            for i, fn in enumerate(COST_FUNCTIONS)
        ],
    )
    n, with_pet = con.sql("SELECT count(*), count(pet_c) FROM edge_factors").fetchone()
    con.close()
    print(
        f"Wrote {n} edges ({with_pet} with PET), {len(FACTORS)} factors "
        f"and {len(COST_FUNCTIONS)} cost functions to {args.db}"
    )


if __name__ == "__main__":
    main()
