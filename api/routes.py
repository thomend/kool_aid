"""API routes backed by DuckDB."""

from fastapi import APIRouter, HTTPException

from db import get_connection

router = APIRouter(prefix="/api")


@router.get("/streets")
async def list_streets(limit: int = 50):
    """Roundtrip: query pedestrian_streets in DuckDB, return as JSON."""
    con = get_connection()
    rows = con.execute(
        "SELECT name, highway_types, segment_count FROM pedestrian_streets "
        "ORDER BY name LIMIT ?",
        [limit],
    ).fetchall()
    con.close()
    return [
        {"name": name, "highway_types": highway_types, "segment_count": segment_count}
        for name, highway_types, segment_count in rows
    ]


@router.get("/streets/{name}")
async def get_street(name: str):
    """Roundtrip: fetch a single named street, including its geometry (WKT)."""
    con = get_connection()
    row = con.execute(
        "SELECT name, highway_types, segment_count, wkt FROM pedestrian_streets WHERE name = ?",
        [name],
    ).fetchone()
    con.close()
    if row is None:
        raise HTTPException(status_code=404, detail=f"Street '{name}' not found")
    name, highway_types, segment_count, wkt = row
    return {"name": name, "highway_types": highway_types, "segment_count": segment_count, "wkt": wkt}
