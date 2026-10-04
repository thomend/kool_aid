"""Route comparison: the shortest and the coolest walking route between two points.

Both routes run on the main component of the graph (api/graph.py). The
shortest one minimises length, the coolest one the walking cost of the chosen
heat profile and factors, with the same formula as the frontend (costModel.ts,
scripts/cost_model.py):

    cost = length_m * slope * (1 + heat_excess_sq_mean * relief / scale_c^2)

Start and end are snapped to the nearest node, at most SNAP_MAX_M away.
Plain Dijkstra on ~14k nodes: a comparison takes ~50-100 ms, no graph library needed.
"""

import heapq
import math

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .graph import DEFAULT_PROFILE, PROFILES, store

WALK_SPEED_M_S = 1.3  # a relaxed walking pace
SNAP_MAX_M = 300.0

router = APIRouter(prefix="/api/route", tags=["route"])


class RoutePoint(BaseModel):
    node: int
    lon: float
    lat: float


class Route(BaseModel):
    edges: list[int]
    coordinates: list[list[float]]  # [lon, lat] from start to end
    length_m: float
    cost_m: float  # walking cost, for the profile and factors asked for
    minutes: float  # walking time at WALK_SPEED_M_S
    shade_share: float  # length-weighted share in tree shade


class RouteComparison(BaseModel):
    start: RoutePoint
    end: RoutePoint
    shortest: Route
    coolest: Route


class _Network:
    """Adjacency of the main component, rebuilt whenever the graph store reloads."""

    def __init__(self):
        self.edges_of = None  # the store.edges this was built from

    def ensure(self):
        if self.edges_of is store.edges:
            return
        self.adjacent = {}  # node -> [(neighbour, edge id)]
        for edge in store.edges.values():
            if edge["heat_excess_sq_mean"] is None or edge["source"] == edge["target"]:
                continue  # outside the main component (no cost), or a loop
            self.adjacent.setdefault(edge["source"], []).append((edge["target"], edge["id"]))
            self.adjacent.setdefault(edge["target"], []).append((edge["source"], edge["id"]))
        self.nodes = [(n, store.nodes[n]["lon"], store.nodes[n]["lat"]) for n in self.adjacent]
        self.routable = sorted({e for edges in self.adjacent.values() for _, e in edges})
        self.edges_of = store.edges

    def nearest(self, lon, lat):
        """Nearest routable node and its distance in metres (equirectangular, fine at city scale)."""
        kx = 111_320 * math.cos(math.radians(lat))
        best = min(self.nodes, key=lambda n: ((n[1] - lon) * kx) ** 2 + ((n[2] - lat) * 111_320) ** 2)
        return best, math.hypot((best[1] - lon) * kx, (best[2] - lat) * 111_320)


network = _Network()


def _factor(edge, model, profile, trees, fountains, slope):
    """Cost per metre of an edge, see the module docstring."""
    relief = (1 - model.shade_effect * (edge["shade_share"] or 0) if trees else 1) * (
        1 - model.fountain_effect * (edge["fountain_share"] or 0) if fountains else 1
    )
    slope_factor = 1 + model.slope_weight[profile] * (edge["slope_excess"] or 0) if slope else 1
    return slope_factor * (1 + edge["heat_excess_sq_mean"] * relief / model.scale_c[profile] ** 2)


def _dijkstra(start, end, weight):
    """The cheapest route as [(node the edge is entered from, edge id)], or None."""
    best = {start: 0.0}
    came_from = {}  # node -> (previous node, edge id)
    queue = [(0.0, start)]
    while queue:
        dist, node = heapq.heappop(queue)
        if node == end:
            break
        if dist > best[node]:
            continue
        for neighbour, edge_id in network.adjacent[node]:
            d = dist + weight[edge_id]
            if d < best.get(neighbour, math.inf):
                best[neighbour] = d
                came_from[neighbour] = (node, edge_id)
                heapq.heappush(queue, (d, neighbour))
    if end not in best:
        return None
    path, node = [], end
    while node != start:
        node, edge_id = came_from[node]
        path.append((node, edge_id))
    return path[::-1]


def _route(path, cost):
    coordinates, length, total_cost, shaded = [], 0.0, 0.0, 0.0
    for entered_from, edge_id in path:
        edge = store.edges[edge_id]
        coords = store.coords[edge_id]
        if entered_from != edge["source"]:
            coords = coords[::-1]  # geometries run from source to target
        coordinates.extend(coords if not coordinates else coords[1:])
        length += edge["length_m"]
        total_cost += cost[edge_id]
        shaded += edge["length_m"] * (edge["shade_share"] or 0)
    return Route(
        edges=[edge_id for _, edge_id in path],
        coordinates=coordinates,
        length_m=round(length, 1),
        cost_m=round(total_cost, 1),
        minutes=round(length / WALK_SPEED_M_S / 60, 1),
        shade_share=round(shaded / length, 3) if length else 0.0,
    )


def _point(text, name):
    try:
        lon, lat = (float(v) for v in text.split(","))
    except ValueError:
        raise HTTPException(422, f"{name} must be 'lon,lat'") from None
    node, distance = network.nearest(lon, lat)
    if distance > SNAP_MAX_M:
        raise HTTPException(422, f"{name} is {distance:.0f} m from the walkable network")
    return node


@router.get("", response_model=RouteComparison)
def compare_routes(
    start: str,
    end: str,
    profile: str = DEFAULT_PROFILE,
    trees: bool = True,
    fountains: bool = True,
    slope: bool = True,
):
    """Shortest and coolest route between two points given as 'lon,lat'."""
    model = store.meta.cost_model
    if model is None:
        raise HTTPException(503, "No cost model yet, run scripts/build_layout.py")
    if profile not in PROFILES:
        raise HTTPException(422, f"profile must be one of {', '.join(PROFILES)}")
    network.ensure()
    a, b = _point(start, "start"), _point(end, "end")
    if a[0] == b[0]:
        raise HTTPException(422, "start and end snap to the same point")
    length = {e: store.edges[e]["length_m"] for e in network.routable}
    cost = {
        e: length[e] * _factor(store.edges[e], model, profile, trees, fountains, slope)
        for e in network.routable
    }
    shortest, coolest = _dijkstra(a[0], b[0], length), _dijkstra(a[0], b[0], cost)
    if shortest is None or coolest is None:
        raise HTTPException(404, "no walkable route between these points")
    return RouteComparison(
        start=RoutePoint(node=a[0], lon=a[1], lat=a[2]),
        end=RoutePoint(node=b[0], lon=b[1], lat=b[2]),
        shortest=_route(shortest, cost),
        coolest=_route(coolest, cost),
    )
