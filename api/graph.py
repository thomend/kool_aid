"""Graph API: serves the walkable network from DuckDB as GeoJSON and JSON.

The database is read once at startup (read-only) and kept in memory, so the
API never holds a lock on the file and the pipeline can rebuild it at any
time. Call POST /api/graph/reload afterwards to pick up the new data
(it also reloads the cost-space layouts).
"""

import json
import os
from pathlib import Path

import duckdb
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


class CostModel(BaseModel):
    """Constants of the walking-cost formula, see scripts/cost_model.py.

    cost = length_m * slope * (1 + heat_excess_sq_mean * relief / scale_c^2), with
    slope  = 1 + slope_weight * slope_excess [slope on]
    relief = (1 - shade_effect * shade_share) [trees on]
           * (1 - fountain_effect * fountain_share) [fountains on]
    """
    pet_threshold_c: float
    shade_effect: float
    fountain_effect: float
    scale_c: dict[str, float]  # per profile
    slope_weight: dict[str, float]  # per profile
    # per profile: median cost per metre without trees, fountains and slope,
    # the fixed reference of the colours and the cost-space layouts
    reference_median: dict[str, float]


class GraphMeta(BaseModel):
    node_count: int
    edge_count: int
    component_count: int
    total_length_km: float
    bounds: Bounds
    cost_model: CostModel | None  # None until scripts/build_layout.py has run


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
    pet_mean_c: float | None  # PET at 14:00, length-weighted mean, degrees C
    # Cost ingredients (see CostModel); None outside the main component, which has no cost
    heat_excess_sq_mean: float | None
    tree_count: int | None  # public trees within 15 m (scripts/join_trees_edges.py)
    shade_share: float | None  # share of the length under a tree crown
    # nearest public fountain (scripts/join_fountains_edges.py), and the share
    # of the length within 100 m of one
    nearest_fountain: str | None
    nearest_fountain_m: float | None
    fountain_share: float | None
    slope_excess: float | None  # extra walking time for the slope (scripts/join_slope_edges.py)
    grade_mean: float | None  # mean |gradient|, 0.05 = 5 %
    grade_max: float | None  # steepest 5 m


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
                SELECT id, source, target, way_osm_id, street_name, highway,
                       is_pedestrian, length_m, component, wkt
                FROM edges
            """).fetchall()
            heat = _optional(con, """
                SELECT edge_id, pet_mean_c, heat_excess_sq_mean, slope_excess FROM edge_heat
            """)  # run scripts/build_layout.py
            slope = _optional(con, """
                SELECT edge_id, grade_mean, grade_max FROM edge_slope
            """)  # run scripts/join_slope_edges.py
            trees = _optional(con, """
                SELECT edge_id, tree_count, shade_share FROM edge_trees
            """)  # run scripts/join_trees_edges.py
            fountains = _optional(con, """
                SELECT ef.edge_id, f.name, ef.nearest_fountain_m, ef.fountain_share
                FROM edge_fountains ef
                LEFT JOIN fountains f ON f.fountain_id = ef.nearest_fountain_id
            """)  # run scripts/join_fountains_edges.py
            cost_model = _load_cost_model(con)
            factor_points = _factor_points(con)
        finally:
            con.close()

        self.nodes = {
            n[0]: dict(zip(("id", "lon", "lat", "degree", "node_type", "component"), n, strict=True))
            for n in nodes
        }
        self.edges = {}
        self.coords = {}  # edge id -> [[lon, lat], ...] from source to target (for routes)
        self.node_edges = {n: [] for n in self.nodes}
        edge_features = []
        for row in edges:
            *fields, wkt = row
            edge = dict(zip(
                ("id", "source", "target", "way_osm_id", "street_name", "highway",
                 "is_pedestrian", "length_m", "component"),
                fields,
                strict=True,
            ))
            pet, excess, slope_excess = heat.get(edge["id"], (None, None, None))
            edge["pet_mean_c"] = _round(pet, 1)
            edge["heat_excess_sq_mean"] = _round(excess, 2)
            edge["slope_excess"] = _round(slope_excess, 4)
            grade_mean, grade_max = slope.get(edge["id"], (None, None))
            edge["grade_mean"] = _round(grade_mean, 3)
            edge["grade_max"] = _round(grade_max, 3)
            tree_count, shade = trees.get(edge["id"], (None, None))
            edge["tree_count"] = tree_count
            edge["shade_share"] = _round(shade, 3)
            name, distance, share = fountains.get(edge["id"], (None, None, None))
            edge["nearest_fountain"] = name
            edge["nearest_fountain_m"] = _round(distance, 0)
            edge["fountain_share"] = _round(share, 3)
            edge["length_m"] = round(edge["length_m"], 1)
            edge = EdgeSummary(**edge).model_dump()
            self.edges[edge["id"]] = edge
            self.node_edges[edge["source"]].append(edge["id"])
            if edge["target"] != edge["source"]:
                self.node_edges[edge["target"]].append(edge["id"])
            coords = shapely.get_coordinates(shapely.from_wkt(wkt)).round(COORD_DECIMALS)
            self.coords[edge["id"]] = coords.tolist()
            edge_features.append(
                {
                    "type": "Feature",
                    "id": edge["id"],
                    "geometry": {"type": "LineString", "coordinates": self.coords[edge["id"]]},
                    # nulls left out, so MapLibre's "has" tells missing values apart
                    "properties": {k: v for k, v in edge.items() if v is not None},
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
        self.factors_geojson = _dump({"type": "FeatureCollection", "features": factor_points})

        lons = [n["lon"] for n in self.nodes.values()]
        lats = [n["lat"] for n in self.nodes.values()]
        self.meta = GraphMeta(
            node_count=len(self.nodes),
            edge_count=len(self.edges),
            component_count=len({n["component"] for n in self.nodes.values()}),
            total_length_km=round(sum(e["length_m"] for e in self.edges.values()) / 1000, 2),
            bounds=Bounds(west=min(lons), south=min(lats), east=max(lons), north=max(lats)),
            cost_model=cost_model,
        )


def _optional(con, sql):
    """{first column: (other columns)} of a query on a table that may not exist yet."""
    try:
        return {row[0]: row[1:] for row in con.sql(sql).fetchall()}
    except (duckdb.CatalogException, duckdb.BinderException):
        return {}


def _factor_points(con):
    """Trees and fountains as GeoJSON point features, for the map (empty without their tables)."""
    points = [
        ("tree", lon, lat, {"species": species, "age": age})
        for lon, lat, species, age in _rows(con, "SELECT lon, lat, species_german, age_years FROM trees")
    ] + [
        ("fountain", lon, lat, {"name": name})
        for lon, lat, name in _rows(con, "SELECT lon, lat, name FROM fountains")
    ]
    return [
        {
            "type": "Feature",
            "geometry": {
                "type": "Point",
                "coordinates": [round(lon, COORD_DECIMALS), round(lat, COORD_DECIMALS)],
            },
            "properties": {"kind": kind, **{k: v for k, v in props.items() if v is not None}},
        }
        for kind, lon, lat, props in points
    ]


def _rows(con, sql):
    try:
        return con.sql(sql).fetchall()
    except (duckdb.CatalogException, duckdb.BinderException):
        return []


def _load_cost_model(con):
    try:
        threshold, shade, fountain = con.sql(
            "SELECT pet_threshold_c, shade_effect, fountain_effect FROM cost_model"
        ).fetchone()
        rows = con.sql("""
            SELECT profile, scale_c, slope_weight, reference_median FROM layout_meta
            WHERE NOT trees AND NOT fountains AND NOT slope
        """).fetchall()
    except (duckdb.CatalogException, duckdb.BinderException):
        return None
    return CostModel(
        pet_threshold_c=threshold,
        shade_effect=shade,
        fountain_effect=fountain,
        scale_c={p: scale for p, scale, _, _ in rows},
        slope_weight={p: weight for p, _, weight, _ in rows},
        reference_median={p: round(ref, 4) for p, _, _, ref in rows},
    )


def _round(value, digits):
    return None if value is None else round(value, digits)


def _dump(obj):
    return json.dumps(obj, separators=(",", ":")).encode()



store = _Store()


@router.get("/meta", response_model=GraphMeta)
def get_meta():
    """Counts and bounds of the graph, and the constants of the cost model."""
    return store.meta


@router.get("/edges", response_description="GeoJSON FeatureCollection of LineStrings")
def get_edges():
    """All edges as GeoJSON. Properties match EdgeSummary."""
    return Response(store.edges_geojson, media_type="application/geo+json")


@router.get("/nodes", response_description="GeoJSON FeatureCollection of Points")
def get_nodes():
    """All nodes as GeoJSON with id, degree, node_type and component."""
    return Response(store.nodes_geojson, media_type="application/geo+json")


@router.get("/factors", response_description="GeoJSON FeatureCollection of Points")
def get_factors():
    """Public trees (species, age) and fountains (name) as GeoJSON, kind = tree | fountain."""
    return Response(store.factors_geojson, media_type="application/geo+json")


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
    """Re-read the database (graph and cost-space layouts), e.g. after a rebuild."""
    from .layout import store as layout_store

    store.load()
    layout_store.load()
    return store.meta
