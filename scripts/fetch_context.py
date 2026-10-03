"""Fetch orientation context for Basel from OpenStreetMap into DuckDB.

The cost-space view has no basemap, so it draws a few landmarks, moved along
with the layout, to keep the city readable:
  context_lines   rivers (Rhein, Wiese, Birs) as LINESTRING WKT in WGS84
  context_labels  district (quarter / suburb) names as points

Usage:
    python scripts/fetch_context.py [--db data/basel.duckdb]
"""

import argparse
from pathlib import Path

import duckdb
from shapely.geometry import LineString
from shapely.ops import linemerge

from fetch_paths import run_overpass

# Slightly larger than the city so rivers run off the edge of the network
BBOX = "47.505,7.53,47.60,7.66"

QUERY = f"""
[out:json][timeout:120];
area["name"="Basel"]["boundary"="administrative"]["admin_level"="8"]->.basel;
(
  way["waterway"="river"]({BBOX});
  node["place"~"^(suburb|quarter)$"](area.basel);
);
out tags geom;
"""


def build_rows(elements):
    rivers = {}
    labels = []
    for el in elements:
        tags = el.get("tags", {})
        if el["type"] == "way":
            # skip unnamed side arms and culverted stretches (e.g. the Birsig in town)
            if not tags.get("name") or tags.get("tunnel"):
                continue
            name = "Rhein" if "Rhein" in tags["name"] else tags["name"]
            coords = [(p["lon"], p["lat"]) for p in el["geometry"]]
            rivers.setdefault(name, []).append(LineString(coords))
        elif el["type"] == "node" and tags.get("name"):
            labels.append((tags["name"], tags["place"], el["lon"], el["lat"]))

    lines = []
    for name, parts in rivers.items():
        merged = linemerge(parts)
        geoms = merged.geoms if merged.geom_type == "MultiLineString" else [merged]
        lines.extend((name, "river", g.wkt) for g in geoms)
    return lines, labels


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--db", type=Path, default=Path("data/basel.duckdb"))
    args = parser.parse_args()

    lines, labels = build_rows(run_overpass(QUERY))

    con = duckdb.connect(str(args.db))
    con.execute(
        "CREATE OR REPLACE TABLE context_lines (name VARCHAR, kind VARCHAR, wkt VARCHAR)"
    )
    con.executemany("INSERT INTO context_lines VALUES (?, ?, ?)", lines)
    con.execute("""
        CREATE OR REPLACE TABLE context_labels (
            name VARCHAR, kind VARCHAR, lon DOUBLE, lat DOUBLE
        )
    """)
    con.executemany("INSERT INTO context_labels VALUES (?, ?, ?, ?)", labels)
    con.close()
    print(f"Wrote {len(lines)} river lines and {len(labels)} district labels to {args.db}")


if __name__ == "__main__":
    main()
