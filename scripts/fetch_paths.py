"""Fetch the walkable network of Basel from OpenStreetMap and store it in DuckDB.

Includes dedicated pedestrian paths (is_pedestrian = true) and streets people
can walk along (is_pedestrian = false), so the network is connected for routing.
Ways tagged foot=no, or private without explicit foot access, are left out.

Creates one table, paths, with two kinds of rows:
  kind = 'way'     one row per OSM way (raw segments, incl. unnamed paths)
  kind = 'street'  one row per named street, its ways merged into one geometry

Geometries are stored as WKT in WGS84 (EPSG:4326, lon/lat).

Usage:
    python scripts/fetch_paths.py [--db data/basel.duckdb]
"""

import argparse
from pathlib import Path

import duckdb
import requests
from shapely.geometry import LineString, Polygon
from shapely.ops import linemerge, unary_union

# Public Overpass instances, tried in order (the main one is often overloaded)
OVERPASS_URLS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]
USER_AGENT = "kool-aid-hackathon/0.1 (walkable path fetcher)"
PEDESTRIAN_TYPES = ["pedestrian", "footway", "path", "steps"]
STREET_TYPES = [
    "living_street",
    "residential",
    "service",
    "unclassified",
    "tertiary",
    "secondary",
    "primary",
    "track",
    "cycleway",  # only with explicit foot access, see is_walkable()
]
HIGHWAY_TYPES = PEDESTRIAN_TYPES + STREET_TYPES

# "out body geom" includes the node ids of each way, needed to find intersections
QUERY = f"""
[out:json][timeout:300];
area["name"="Basel"]["boundary"="administrative"]["admin_level"="8"]->.basel;
way["highway"~"^({'|'.join(HIGHWAY_TYPES)})$"](area.basel);
out body geom;
"""


def fetch_ways():
    errors = []
    for url in OVERPASS_URLS:
        try:
            resp = requests.post(
                url,
                data={"data": QUERY},
                headers={"User-Agent": USER_AGENT},
                timeout=300,
            )
            resp.raise_for_status()
            return resp.json()["elements"]
        except requests.RequestException as e:
            errors.append(f"{url}: {e}")
    raise RuntimeError("All Overpass endpoints failed:\n" + "\n".join(errors))


def is_walkable(tags):
    foot = tags.get("foot")
    if foot in ("no", "private"):
        return False
    if foot in ("yes", "designated", "permissive"):
        return True
    if tags.get("highway") == "cycleway":
        return False
    return tags.get("access") not in ("no", "private")


def to_geometry(way):
    coords = [(p["lon"], p["lat"]) for p in way["geometry"]]
    tags = way.get("tags", {})
    # Closed ways tagged area=yes (e.g. pedestrian squares) are polygons
    if len(coords) >= 4 and coords[0] == coords[-1] and tags.get("area") == "yes":
        return Polygon(coords)
    return LineString(coords)


def build_rows(elements):
    ways = []
    for el in elements:
        if el.get("type") != "way" or len(el.get("geometry", [])) < 2:
            continue
        tags = el.get("tags", {})
        if not is_walkable(tags):
            continue
        ways.append(
            {
                "osm_id": el["id"],
                "name": tags.get("name"),
                "highway": tags.get("highway"),
                "is_pedestrian": tags.get("highway") in PEDESTRIAN_TYPES,
                "footway": tags.get("footway"),  # e.g. sidewalk, crossing
                "surface": tags.get("surface"),
                "sidewalk": tags.get("sidewalk"),  # e.g. both, separate, no
                "node_ids": el["nodes"],
                "geom": to_geometry(el),
            }
        )

    streets = {}
    for w in ways:
        if w["name"]:
            streets.setdefault(w["name"], []).append(w)

    rows = [
        (
            "way",
            w["osm_id"],
            w["name"],
            w["highway"],
            w["is_pedestrian"],
            w["footway"],
            w["surface"],
            w["sidewalk"],
            1,
            w["node_ids"],
            w["geom"].wkt,
        )
        for w in ways
    ]
    for name, parts in streets.items():
        lines = [p["geom"] for p in parts if p["geom"].geom_type == "LineString"]
        polys = [p["geom"] for p in parts if p["geom"].geom_type == "Polygon"]
        geom = linemerge(lines) if lines else None
        if polys:
            geom = unary_union([g for g in [geom, *polys] if g is not None])
        rows.append(
            (
                "street",
                None,
                name,
                ",".join(sorted({p["highway"] for p in parts})),
                all(p["is_pedestrian"] for p in parts),
                None,
                None,
                None,
                len(parts),
                None,
                geom.wkt,
            )
        )
    return rows


def write_db(db_path, rows):
    db_path.parent.mkdir(parents=True, exist_ok=True)
    con = duckdb.connect(str(db_path))
    con.execute("DROP TABLE IF EXISTS pedestrian_paths")
    con.execute("""
        CREATE OR REPLACE TABLE paths (
            id INTEGER PRIMARY KEY,
            kind VARCHAR NOT NULL CHECK (kind IN ('way', 'street')),
            osm_id BIGINT,        -- set for ways, NULL for streets
            name VARCHAR,
            highway VARCHAR,      -- for streets: all highway types of its ways
            is_pedestrian BOOLEAN, -- dedicated pedestrian path (street: all its ways)
            footway VARCHAR,
            surface VARCHAR,
            sidewalk VARCHAR,
            segment_count INTEGER,
            node_ids BIGINT[],    -- OSM node ids along the way, NULL for streets
            wkt VARCHAR
        )
    """)
    con.executemany(
        "INSERT INTO paths VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [(i, *row) for i, row in enumerate(rows, start=1)],
    )
    con.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--db", type=Path, default=Path("data/basel.duckdb"))
    args = parser.parse_args()

    elements = fetch_ways()
    rows = build_rows(elements)
    write_db(args.db, rows)
    n_streets = sum(r[0] == "street" for r in rows)
    print(f"Wrote {len(rows) - n_streets} ways and {n_streets} streets to {args.db}")


if __name__ == "__main__":
    main()
