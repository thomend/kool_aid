"""Fetch pedestrian paths in Basel from OpenStreetMap and store them in DuckDB.

Creates two tables:
  pedestrian_ways     one row per OSM way (raw segments, incl. unnamed paths)
  pedestrian_streets  one row per named street, segments merged into one geometry

Geometries are stored as WKT in WGS84 (EPSG:4326, lon/lat).

Usage:
    python scripts/fetch_pedestrian_paths.py [--db data/pedestrian_paths.duckdb]
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
USER_AGENT = "kool-aid-hackathon/0.1 (pedestrian path fetcher)"
HIGHWAY_TYPES = ["pedestrian", "footway", "path", "steps"]

QUERY = f"""
[out:json][timeout:180];
area["name"="Basel"]["boundary"="administrative"]["admin_level"="8"]->.basel;
way["highway"~"^({'|'.join(HIGHWAY_TYPES)})$"](area.basel);
out tags geom;
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
        ways.append(
            {
                "osm_id": el["id"],
                "name": tags.get("name"),
                "highway": tags.get("highway"),
                "footway": tags.get("footway"),  # e.g. sidewalk, crossing
                "surface": tags.get("surface"),
                "geom": to_geometry(el),
            }
        )

    streets = {}
    for w in ways:
        if w["name"]:
            streets.setdefault(w["name"], []).append(w)

    street_rows = []
    for name, parts in streets.items():
        lines = [p["geom"] for p in parts if p["geom"].geom_type == "LineString"]
        polys = [p["geom"] for p in parts if p["geom"].geom_type == "Polygon"]
        geom = linemerge(lines) if lines else None
        if polys:
            geom = unary_union([g for g in [geom, *polys] if g is not None])
        street_rows.append(
            (
                name,
                ",".join(sorted({p["highway"] for p in parts})),
                len(parts),
                geom.wkt,
            )
        )

    way_rows = [
        (w["osm_id"], w["name"], w["highway"], w["footway"], w["surface"], w["geom"].wkt)
        for w in ways
    ]
    return way_rows, street_rows


def write_db(db_path, way_rows, street_rows):
    db_path.parent.mkdir(parents=True, exist_ok=True)
    con = duckdb.connect(str(db_path))
    con.execute("""
        CREATE OR REPLACE TABLE pedestrian_ways (
            osm_id BIGINT PRIMARY KEY,
            name VARCHAR,
            highway VARCHAR,
            footway VARCHAR,
            surface VARCHAR,
            wkt VARCHAR
        )
    """)
    con.executemany("INSERT INTO pedestrian_ways VALUES (?, ?, ?, ?, ?, ?)", way_rows)
    con.execute("""
        CREATE OR REPLACE TABLE pedestrian_streets (
            name VARCHAR PRIMARY KEY,
            highway_types VARCHAR,
            segment_count INTEGER,
            wkt VARCHAR
        )
    """)
    con.executemany("INSERT INTO pedestrian_streets VALUES (?, ?, ?, ?)", street_rows)
    con.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--db", type=Path, default=Path("data/pedestrian_paths.duckdb"))
    args = parser.parse_args()

    elements = fetch_ways()
    way_rows, street_rows = build_rows(elements)
    write_db(args.db, way_rows, street_rows)
    print(f"Wrote {len(way_rows)} ways and {len(street_rows)} named streets to {args.db}")


if __name__ == "__main__":
    main()
