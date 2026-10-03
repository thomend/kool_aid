"""Graph API: serves the walkable network from DuckDB as GeoJSON and JSON.

The database is read once at startup (read-only) and kept in memory, so the
API never holds a lock on the file and build_graph.py can rebuild it at any
time. Call POST /api/graph/reload afterwards to pick up the new data
(it also reloads the cost-space layout).
"""

import json
import os
from pathlib import Path

import duckdb
import numpy as np
import shapely
from fastapi import APIRouter, HTTPException, Response
from pydantic import BaseModel

DB_PATH = Path(os.environ.get("KOOL_DB", Path(__file__).parents[1] / "data" / "basel.duckdb"))
COORD_DECIMALS = 6  # ~0.1 m

# Heat-sensitivity profiles, see scripts/cost_model.py
PROFILES = ("low", "medium", "high")
DEFAULT_PROFILE = "medium"

router = APIRouter(prefix="/api/graph", tags=["graph"])


class Bounds(BaseModel):
    west: float
    south: float
    east: float
    north: float


class GraphMeta(BaseModel):
    node_count: int
    edge_count: int
    component_count: int
    total_length_km: float
    bounds: Bounds
    length_quantiles_m: dict[str, float]  # p10..p90, for colour scales
    # p10..p90 of the default profile's walk cost; one scale for all profiles
    # so switching profiles visibly changes the colours
    walk_cost_quantiles_m: dict[str, float]
    # length-weighted median heat factor per profile (layout_meta), the
    # reference the heat colour scale and the cost-space layout are relative to
    heat_factor_median: dict[str, float]
    highway_counts: dict[str, int]
    node_type_counts: dict[str, int]


class EdgeSummary(BaseModel):
    id: int
    source: int
    target: int
    way_osm_id: int
    street_name: str | None
    highway: str
    is_pedestrian: bool
    length_m: float
    component: int
    pet_mean_c: float | None  # PET at 14:00 today, length-weighted mean, degrees C
    # length_m inflated for heat stress, per profile; see scripts/cost_model.py
    walk_cost_m: dict[str, float]
    # walk_cost_m / length_m per profile; None outside the main component (no cost)
    heat_factor: dict[str, float] | None


class NodeDetail(BaseModel):
    id: int
    lon: float
    lat: float
    degree: int
    node_type: str
    component: int
    street_names: list[str]
    edges: list[EdgeSummary]


class _Store:
    """In-memory copy of the graph, with pre-serialized GeoJSON."""

    def load(self):
        con = duckdb.connect(str(DB_PATH), read_only=True)
        try:
            nodes = con.sql(
                "SELECT id, lon, lat, degree, node_type, component FROM nodes"
            ).fetchall()
            edges = con.sql("""
                SELECT e.id, e.source, e.target, e.way_osm_id, e.street_name, e.highway,
                       e.is_pedestrian, e.length_m, e.component, ec.pet_mean_c, e.wkt
                FROM edges e
                LEFT JOIN edge_cost ec ON ec.edge_id = e.id AND ec.profile = $1
            """, params=[DEFAULT_PROFILE]).fetchall()
            costs = con.sql("SELECT profile, edge_id, cost_m FROM edge_cost").fetchall()
            medians = dict(con.sql("SELECT profile, heat_factor_median FROM layout_meta").fetchall())
        except duckdb.CatalogException:
            # edge_cost not built yet (run scripts/build_layout.py): fall back to length.
            edges = con.sql("""
                SELECT id, source, target, way_osm_id, street_name, highway,
                       is_pedestrian, length_m, component, NULL AS pet_mean_c, wkt
                FROM edges
            """).fetchall()
            costs = []
            medians = {}
        finally:
            con.close()

        cost_of = {(p, e): c for p, e, c in costs}
        edge_fields = [f for f in EdgeSummary.model_fields if f not in ("walk_cost_m", "heat_factor")]
        self.nodes = {
            n[0]: dict(zip(("id", "lon", "lat", "degree", "node_type", "component"), n))
            for n in nodes
        }
        self.edges = {}
        self.node_edges = {n: [] for n in self.nodes}
        edge_features = []
        for row in edges:
            *fields, wkt = row
            edge = dict(zip(edge_fields, fields))
            edge["walk_cost_m"] = {
                p: round(cost_of.get((p, edge["id"]), edge["length_m"]), 1) for p in PROFILES
            }
            edge["heat_factor"] = (
                {
                    p: round(cost_of[(p, edge["id"])] / max(edge["length_m"], 1e-6), 3)
                    for p in PROFILES
                }
                if (DEFAULT_PROFILE, edge["id"]) in cost_of
                else None
            )
            edge = EdgeSummary(**edge).model_dump()
            edge["length_m"] = round(edge["length_m"], 1)
            if edge["pet_mean_c"] is not None:
                edge["pet_mean_c"] = round(edge["pet_mean_c"], 1)
            self.edges[edge["id"]] = edge
            self.node_edges[edge["source"]].append(edge["id"])
            if edge["target"] != edge["source"]:
                self.node_edges[edge["target"]].append(edge["id"])
            coords = shapely.get_coordinates(shapely.from_wkt(wkt)).round(COORD_DECIMALS)
            edge_features.append(
                {
                    "type": "Feature",
                    "id": edge["id"],
                    "geometry": {"type": "LineString", "coordinates": coords.tolist()},
                    # flat properties: MapLibre expressions can't read nested objects
                    "properties": {
                        **{k: v for k, v in edge.items() if k not in ("walk_cost_m", "heat_factor")},
                        **{f"walk_cost_m_{p}": c for p, c in edge["walk_cost_m"].items()},
                        **{f"heat_factor_{p}": f for p, f in (edge["heat_factor"] or {}).items()},
                    },
                }
            )

        node_features = [
            {
                "type": "Feature",
                "id": n["id"],
                "geometry": {
                    "type": "Point",
                    "coordinates": [round(n["lon"], COORD_DECIMALS), round(n["lat"], COORD_DECIMALS)],
                },
                "properties": {k: n[k] for k in ("id", "degree", "node_type", "component")},
            }
            for n in self.nodes.values()
        ]

        self.edges_geojson = _dump({"type": "FeatureCollection", "features": edge_features})
        self.nodes_geojson = _dump({"type": "FeatureCollection", "features": node_features})

        quantiles = _quantiles([e["length_m"] for e in self.edges.values()])
        cost_quantiles = _quantiles(
            [e["walk_cost_m"][DEFAULT_PROFILE] for e in self.edges.values()]
        )
        lons = [n["lon"] for n in self.nodes.values()]
        lats = [n["lat"] for n in self.nodes.values()]
        self.meta = GraphMeta(
            node_count=len(self.nodes),
            edge_count=len(self.edges),
            component_count=len({n["component"] for n in self.nodes.values()}),
            total_length_km=round(sum(e["length_m"] for e in self.edges.values()) / 1000, 2),
            bounds=Bounds(west=min(lons), south=min(lats), east=max(lons), north=max(lats)),
            length_quantiles_m=quantiles,
            walk_cost_quantiles_m=cost_quantiles,
            heat_factor_median={p: round(medians.get(p, 1.0), 3) for p in PROFILES},
            highway_counts=_count(e["highway"] for e in self.edges.values()),
            node_type_counts=_count(n["node_type"] for n in self.nodes.values()),
        )


def _quantiles(values):
    """p10..p90 for colour scales."""
    qs = np.percentile(values, [10, 25, 50, 75, 90])
    return {f"p{p}": round(float(q), 1) for p, q in zip((10, 25, 50, 75, 90), qs)}


def _dump(obj):
    return json.dumps(obj, separators=(",", ":")).encode()


def _count(values):
    counts = {}
    for v in values:
        counts[v] = counts.get(v, 0) + 1
    return dict(sorted(counts.items(), key=lambda kv: -kv[1]))


store = _Store()


@router.get("/meta", response_model=GraphMeta)
def get_meta():
    """Counts, bounds and value ranges of the graph."""
    return store.meta


@router.get("/edges", response_description="GeoJSON FeatureCollection of LineStrings")
def get_edges():
    """All edges as GeoJSON. Properties match EdgeSummary."""
    return Response(store.edges_geojson, media_type="application/geo+json")


@router.get("/nodes", response_description="GeoJSON FeatureCollection of Points")
def get_nodes():
    """All nodes as GeoJSON with id, degree, node_type and component."""
    return Response(store.nodes_geojson, media_type="application/geo+json")


@router.get("/nodes/{node_id}", response_model=NodeDetail)
def get_node(node_id: int):
    """One node with the edges and street names that meet there."""
    node = store.nodes.get(node_id)
    if node is None:
        raise HTTPException(404, f"node {node_id} not found")
    edges = [store.edges[e] for e in store.node_edges[node_id]]
    streets = sorted({e["street_name"] for e in edges if e["street_name"]})
    return NodeDetail(**node, street_names=streets, edges=edges)


@router.get("/edges/{edge_id}", response_model=EdgeSummary)
def get_edge(edge_id: int):
    """One edge's attributes."""
    edge = store.edges.get(edge_id)
    if edge is None:
        raise HTTPException(404, f"edge {edge_id} not found")
    return edge


@router.post("/reload", response_model=GraphMeta)
def reload():
    """Re-read the database (graph and cost-space layout), e.g. after a rebuild."""
    from .layout import store as layout_store

    store.load()
    layout_store.load()
    return store.meta
