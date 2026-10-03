"""API routes backed by DuckDB."""

from db import get_connection
from fastapi import APIRouter, HTTPException

router = APIRouter(prefix="/api")


@router.get("/streets")
async def list_streets(limit: int = 50):
    """Roundtrip: query the street rows (kind='street') in the paths table, return as JSON."""
    con = get_connection()
    rows = con.execute(
        "SELECT name, highway, segment_count FROM paths "
        "WHERE kind = 'street' ORDER BY name LIMIT ?",
        [limit],
    ).fetchall()
    con.close()
    return [
        {"name": name, "highway": highway, "segment_count": segment_count}
        for name, highway, segment_count in rows
    ]


@router.get("/streets/{name}")
async def get_street(name: str):
    """Roundtrip: fetch a single named street, including its geometry (WKT)."""
    con = get_connection()
    row = con.execute(
        "SELECT name, highway, segment_count, wkt FROM paths WHERE kind = 'street' AND name = ?",
        [name],
    ).fetchone()
    con.close()
    if row is None:
        raise HTTPException(status_code=404, detail=f"Street '{name}' not found")
    name, highway, segment_count, wkt = row
    return {"name": name, "highway": highway, "segment_count": segment_count, "wkt": wkt}
