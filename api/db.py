"""Tiny DuckDB connection helper shared by the API routes."""

from pathlib import Path

import duckdb

DB_PATH = Path(__file__).resolve().parent.parent / "data" / "basel.duckdb"


def get_connection():
    """Open a fresh read-only connection to the local DuckDB file."""
    return duckdb.connect(str(DB_PATH), read_only=True)
