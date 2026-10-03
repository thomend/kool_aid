"""Quick look at what has been loaded into the local DuckDB file.

Prints every table's schema, row count, and a couple of sample rows.

Usage:
    python scripts/inspect_db.py [--db data/pedestrian_paths.duckdb]
"""

import argparse
from pathlib import Path

import duckdb


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--db", type=Path, default=Path("data/pedestrian_paths.duckdb"))
    args = parser.parse_args()

    con = duckdb.connect(str(args.db), read_only=True)
    tables = [row[0] for row in con.execute("SHOW TABLES").fetchall()]
    print(f"DB: {args.db}  ({len(tables)} tables)\n")

    for table in tables:
        count = con.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
        columns = con.execute(f"DESCRIBE {table}").fetchall()
        print(f"--- {table} ({count} rows) ---")
        for name, col_type, *_ in columns:
            print(f"  {name}: {col_type}")
        sample = con.execute(f"SELECT * FROM {table} LIMIT 2").fetchall()
        print("  sample:", sample)
        print()

    con.close()


if __name__ == "__main__":
    main()
