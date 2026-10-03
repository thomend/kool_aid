"""Build the walkable routing graph of Basel from the paths table in DuckDB.

Reads the OSM ways written by fetch_paths.py and creates:
  nodes       intersections, junctions and dead ends (one row per OSM node)
  edges       sections of a way between two nodes, undirected, with length in metres
  node_paths  view: the ways and street names that meet at each node

A node is every OSM node that ends a way or is shared by several ways, so
bridges and tunnels crossing a path do not create fake intersections.
Pedestrian areas mapped as polygons (e.g. squares) are not part of the graph.

Usage:
    python scripts/build_graph.py [--db data/basel.duckdb]
"""

import argparse
from collections import Counter
from pathlib import Path

import duckdb
import numpy as np
import pandas as pd
import shapely
from pyproj import Transformer
from shapely.geometry import LineString

# WGS84 lon/lat -> Swiss LV95 (metres)
TO_LV95 = Transformer.from_crs("EPSG:4326", "EPSG:2056", always_xy=True)


def load_ways(con):
    rows = con.execute("""
        SELECT osm_id, name, highway, is_pedestrian, node_ids, wkt
        FROM paths
        WHERE kind = 'way' AND wkt LIKE 'LINESTRING%'
    """).fetchall()
    ways = []
    for osm_id, name, highway, is_pedestrian, node_ids, wkt in rows:
        coords = shapely.get_coordinates(shapely.from_wkt(wkt))
        if len(coords) != len(node_ids):
            raise ValueError(f"way {osm_id}: {len(coords)} coords but {len(node_ids)} nodes")
        ways.append(
            {
                "osm_id": osm_id,
                "name": name,
                "highway": highway,
                "is_pedestrian": is_pedestrian,
                "node_ids": node_ids,
                "lonlat": coords,
            }
        )
    return ways


def find_graph_nodes(ways):
    """OSM nodes that end a way or occur more than once across all ways."""
    occurrences = Counter(n for w in ways for n in w["node_ids"])
    graph_nodes = {n for n, count in occurrences.items() if count > 1}
    for w in ways:
        graph_nodes.add(w["node_ids"][0])
        graph_nodes.add(w["node_ids"][-1])
    return graph_nodes


def split_ways(ways, graph_nodes):
    """Cut every way at its graph nodes; each piece becomes one edge."""
    edges = []
    positions = {}  # node id -> (lon, lat, x, y)
    for w in ways:
        lonlat = w["lonlat"]
        x, y = TO_LV95.transform(lonlat[:, 0], lonlat[:, 1])
        xy = np.column_stack([x, y])
        # cumulative distance along the way, in metres
        dist = np.concatenate([[0.0], np.cumsum(np.hypot(*np.diff(xy, axis=0).T))])

        node_ids = w["node_ids"]
        start = 0
        for i, node in enumerate(node_ids):
            if node not in graph_nodes:
                continue
            positions.setdefault(node, (*lonlat[i], *xy[i]))
            if i == 0:
                continue
            edges.append(
                {
                    "source": node_ids[start],
                    "target": node,
                    "way_osm_id": w["osm_id"],
                    "street_name": w["name"],
                    "highway": w["highway"],
                    "is_pedestrian": w["is_pedestrian"],
                    "length_m": dist[i] - dist[start],
                    "wkt": LineString(lonlat[start : i + 1]).wkt,
                }
            )
            start = i
    return edges, positions


def label_components(edges, node_ids):
    """Connected components via union-find; 0 is the largest component."""
    parent = {n: n for n in node_ids}

    def find(n):
        while parent[n] != n:
            parent[n] = parent[parent[n]]
            n = parent[n]
        return n

    for e in edges:
        parent[find(e["source"])] = find(e["target"])

    roots = {n: find(n) for n in node_ids}
    ranked = [root for root, _ in Counter(roots.values()).most_common()]
    rank = {root: i for i, root in enumerate(ranked)}
    return {n: rank[root] for n, root in roots.items()}


def build_tables(ways):
    graph_nodes = find_graph_nodes(ways)
    edges, positions = split_ways(ways, graph_nodes)

    degree = Counter()
    for e in edges:
        degree[e["source"]] += 1
        degree[e["target"]] += 1
    component = label_components(edges, positions.keys())

    nodes_df = pd.DataFrame(
        [
            {
                "id": n,
                "lon": lon,
                "lat": lat,
                "x": x,
                "y": y,
                "degree": degree[n],
                "node_type": "dead_end"
                if degree[n] == 1
                else "junction"
                if degree[n] == 2
                else "intersection",
                "component": component[n],
            }
            for n, (lon, lat, x, y) in positions.items()
        ]
    )
    edges_df = pd.DataFrame(edges)
    edges_df.insert(0, "id", range(1, len(edges_df) + 1))
    edges_df["component"] = edges_df["source"].map(component)
    return nodes_df, edges_df


def write_db(con, nodes_df, edges_df):
    con.execute("DROP VIEW IF EXISTS node_paths")
    con.execute("DROP TABLE IF EXISTS edges")
    con.execute("DROP TABLE IF EXISTS nodes")
    con.execute("""
        CREATE TABLE nodes (
            id BIGINT PRIMARY KEY,  -- OSM node id
            lon DOUBLE,             -- WGS84
            lat DOUBLE,
            x DOUBLE,               -- Swiss LV95 (EPSG:2056), metres
            y DOUBLE,
            degree INTEGER,         -- number of edges meeting here
            node_type VARCHAR CHECK (node_type IN ('intersection', 'junction', 'dead_end')),
            component INTEGER       -- connected component, 0 = largest
        )
    """)
    con.execute("""
        CREATE TABLE edges (
            id INTEGER PRIMARY KEY,
            source BIGINT REFERENCES nodes (id),
            target BIGINT REFERENCES nodes (id),
            way_osm_id BIGINT,      -- OSM way this section belongs to
            street_name VARCHAR,    -- matches paths.name of the street row, NULL if unnamed
            highway VARCHAR,
            is_pedestrian BOOLEAN,
            length_m DOUBLE,        -- along the geometry, measured in LV95
            component INTEGER,
            wkt VARCHAR             -- LINESTRING in WGS84
        )
    """)
    con.execute("INSERT INTO nodes BY NAME SELECT * FROM nodes_df")
    con.execute("INSERT INTO edges BY NAME SELECT * FROM edges_df")
    con.execute("""
        CREATE VIEW node_paths AS
        WITH ends AS (
            SELECT source AS node_id, way_osm_id, street_name FROM edges
            UNION ALL
            SELECT target, way_osm_id, street_name FROM edges
        )
        SELECT
            n.id AS node_id,
            n.lon,
            n.lat,
            list(DISTINCT e.way_osm_id ORDER BY e.way_osm_id) AS way_osm_ids,
            list(DISTINCT e.street_name ORDER BY e.street_name)
                FILTER (WHERE e.street_name IS NOT NULL) AS street_names
        FROM nodes n
        JOIN ends e ON e.node_id = n.id
        GROUP BY n.id, n.lon, n.lat
    """)


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--db", type=Path, default=Path("data/basel.duckdb"))
    args = parser.parse_args()

    con = duckdb.connect(str(args.db))
    nodes_df, edges_df = build_tables(load_ways(con))
    write_db(con, nodes_df, edges_df)
    con.close()

    n_components = nodes_df["component"].nunique()
    print(
        f"Wrote {len(nodes_df)} nodes and {len(edges_df)} edges "
        f"({n_components} connected components) to {args.db}"
    )


if __name__ == "__main__":
    main()
