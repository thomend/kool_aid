"""Cost-space layout API: graph positions where edge length on screen = cost.

Serves geographic and cost-space coordinates side by side, in metres relative
to a common origin (Swiss LV95), so the frontend can morph between the two.
Data is columnar (flat coordinate lists) to keep the payload small and to
load straight into GPU buffers.

There is one layout per heat-sensitivity profile (see scripts/cost_model.py) and
relief variant (tree shade and fountains each counted or not). Each is built on
first request and then cached.

Built by scripts/build_layout.py (node_layout, layout_meta) and
scripts/fetch_context.py (context_lines, context_labels).
"""

import json
import threading

import duckdb
import numpy as np
import shapely
from fastapi import APIRouter, HTTPException, Response
from pyproj import Transformer

from .graph import DB_PATH, DEFAULT_PROFILE, PROFILES

router = APIRouter(prefix="/api/layout", tags=["layout"])

TO_LV95 = Transformer.from_crs("EPSG:4326", "EPSG:2056", always_xy=True)
DECIMALS = 1  # 0.1 m
IDW_NEIGHBOURS = 8
GRID_SPACING_M = 250  # background grid warped along with the network
GRID_STEP_M = 50  # vertex spacing along grid lines
GRID_REACH_M = 200  # grid is only drawn this close to the network


class _Store:
    """Cost-space payloads per (profile, trees, fountains), built on first request."""

    def __init__(self):
        self.payloads: dict[tuple[str, bool, bool], bytes] = {}
        self.error: str | None = None
        self.lock = threading.Lock()

    def load(self):
        """Drop the cache and build the default variant, which also checks the tables.

        The other variants are then built in the background (~5 s each), so
        switching profiles or relief is instant once they are done.
        """
        with self.lock:
            self.payloads = {}
        if self.get(DEFAULT_PROFILE, True, True) is not None:
            threading.Thread(target=self._warm, daemon=True).start()

    def _warm(self):
        for profile in PROFILES:
            for trees in (True, False):
                for fountains in (True, False):
                    self.get(profile, trees, fountains)

    def get(self, profile, trees, fountains):
        key = (profile, trees, fountains)
        with self.lock:  # one build at a time; the others wait and then hit the cache
            if key not in self.payloads:
                try:
                    con = duckdb.connect(str(DB_PATH), read_only=True)
                    self.payloads[key] = _dump(_build(con, *key))
                    self.error = None
                except (duckdb.CatalogException, duckdb.BinderException, IndexError) as e:
                    self.error = (
                        f"Layout tables missing or outdated, run scripts/build_layout.py ({e})"
                    )
                    return None
            return self.payloads[key]


def _build(con, profile, trees, fountains):
    variant = [profile, trees, fountains]
    try:
        meta = con.sql(
            "SELECT * FROM layout_meta WHERE profile = $1 AND trees = $2 AND fountains = $3",
            params=variant,
        ).fetchdf().iloc[0].to_dict()
        nodes = con.sql("""
            SELECT n.id, n.node_type, n.degree, n.x, n.y, l.x AS lx, l.y AS ly
            FROM nodes n JOIN node_layout l
              ON l.node_id = n.id AND l.profile = $1 AND l.trees = $2 AND l.fountains = $3
            ORDER BY n.id
        """, params=variant).fetchnumpy()
        edges = con.sql("""
            SELECT e.id, e.source, e.target, e.street_name, e.highway, e.is_pedestrian,
                   e.length_m, h.pet_mean_c, h.heat_excess_sq_mean, h.shade_share,
                   h.fountain_share, e.wkt
            FROM edges e JOIN edge_heat h ON h.edge_id = e.id
            WHERE e.component = 0
            ORDER BY e.id
        """).fetchnumpy()
        try:
            lines = con.sql("SELECT name, wkt FROM context_lines").fetchall()
            labels = con.sql("SELECT name, kind, lon, lat FROM context_labels").fetchall()
        except duckdb.CatalogException:
            lines, labels = [], []
    finally:
        con.close()

    geo_xy = np.column_stack([nodes["x"], nodes["y"]])
    cost_xy = np.column_stack([nodes["lx"], nodes["ly"]])
    origin = geo_xy.mean(axis=0).round()
    index = {node_id: i for i, node_id in enumerate(nodes["id"])}

    # Edges: geographic polyline, and a straight line between the cost-space
    # node positions with the same number of vertices (placed at the same
    # fraction of arc length), so the two can be interpolated vertex by vertex.
    geo_parts, cost_parts, starts = [], [], [0]
    for wkt, s, t in zip(edges["wkt"], edges["source"], edges["target"]):
        lonlat = shapely.get_coordinates(shapely.from_wkt(wkt))
        x, y = TO_LV95.transform(lonlat[:, 0], lonlat[:, 1])
        path = np.column_stack([x, y])
        seg = np.linalg.norm(np.diff(path, axis=0), axis=1)
        frac = np.concatenate([[0], np.cumsum(seg)]) / max(seg.sum(), 1e-9)
        p0, p1 = cost_xy[index[s]], cost_xy[index[t]]
        geo_parts.append(path)
        if s == t:  # closed ring: keep its shape, move it with its node
            cost_parts.append(path + (p0 - geo_xy[index[s]]))
        else:
            cost_parts.append(p0 + frac[:, None] * (p1 - p0))
        starts.append(starts[-1] + len(path))
    geo_paths = np.concatenate(geo_parts)
    cost_paths = np.concatenate(cost_parts)

    shift = _displacement_field(geo_xy, cost_xy - geo_xy)
    context_lines = []
    for name, wkt in lines:
        lonlat = shapely.get_coordinates(shapely.from_wkt(wkt))
        pts = np.column_stack(TO_LV95.transform(lonlat[:, 0], lonlat[:, 1]))
        context_lines.append(
            {"name": name, "geo": _flat(pts, origin), "cost": _flat(pts + shift(pts), origin)}
        )
    context_labels = []
    for name, kind, lon, lat in labels:
        pt = np.array([TO_LV95.transform(lon, lat)])
        context_labels.append(
            {
                "name": name,
                "kind": kind,
                "geo": _flat(pt, origin),
                "cost": _flat(pt + shift(pt), origin),
            }
        )

    grid = [
        {"geo": _flat(line, origin), "cost": _flat(line + shift(line), origin)}
        for line in _grid_lines(geo_xy)
    ]

    all_pts = np.vstack([geo_xy, cost_xy]) - origin
    return {
        "meta": {
            k: v.isoformat() if hasattr(v, "isoformat") else v.item() if hasattr(v, "item") else v
            for k, v in meta.items()
        },
        "origin_lv95": origin.tolist(),
        "bounds": {
            "min_x": float(all_pts[:, 0].min()),
            "min_y": float(all_pts[:, 1].min()),
            "max_x": float(all_pts[:, 0].max()),
            "max_y": float(all_pts[:, 1].max()),
        },
        "nodes": {
            "ids": nodes["id"].tolist(),
            "node_type": nodes["node_type"].tolist(),
            "degree": nodes["degree"].tolist(),
            "geo": _flat(geo_xy, origin),
            "cost": _flat(cost_xy, origin),
        },
        "edges": {
            "ids": edges["id"].tolist(),
            "source": edges["source"].tolist(),
            "target": edges["target"].tolist(),
            "street_name": [None if v is None else str(v) for v in edges["street_name"]],
            "highway": edges["highway"].tolist(),
            "is_pedestrian": edges["is_pedestrian"].tolist(),
            "length_m": edges["length_m"].round(1).tolist(),
            "pet_mean_c": _nullable_floats(edges["pet_mean_c"]),
            # cost ingredients, see CostModel in graph.py
            "heat_excess_sq_mean": edges["heat_excess_sq_mean"].round(2).tolist(),
            "shade_share": edges["shade_share"].round(3).tolist(),
            "fountain_share": edges["fountain_share"].round(3).tolist(),
            "start_indices": starts[:-1],
            "geo": _flat(geo_paths, origin),
            "cost": _flat(cost_paths, origin),
        },
        "context": {"lines": context_lines, "labels": context_labels, "grid": grid},
    }


def _grid_lines(nodes_xy):
    """A regular grid over the network, as polylines cut where they leave it.

    Lines run on GRID_SPACING_M multiples (LV95), with a vertex every
    GRID_STEP_M so they can bend when displaced into cost space.
    """
    # cells of GRID_STEP_M with a node, grown by GRID_REACH_M: "near the network"
    cell = np.floor(nodes_xy / GRID_STEP_M).astype(int)
    reach = GRID_REACH_M // GRID_STEP_M
    c0 = cell.min(axis=0) - reach
    occupied = np.zeros(tuple(cell.max(axis=0) - c0 + reach + 1), bool)
    occupied[tuple((cell - c0).T)] = True
    near_mask = np.zeros_like(occupied)
    for dx in range(-reach, reach + 1):
        for dy in range(-reach, reach + 1):
            if dx * dx + dy * dy <= reach * reach:
                near_mask |= np.roll(occupied, (dx, dy), axis=(0, 1))

    def is_near(pts):
        c = np.floor(pts / GRID_STEP_M).astype(int) - c0
        inside = ((c >= 0) & (c < near_mask.shape)).all(axis=1)
        out = np.zeros(len(pts), bool)
        out[inside] = near_mask[tuple(c[inside].T)]
        return out

    lo = np.floor(nodes_xy.min(axis=0) / GRID_SPACING_M) * GRID_SPACING_M
    hi = np.ceil(nodes_xy.max(axis=0) / GRID_SPACING_M) * GRID_SPACING_M
    lines = []
    for axis in (0, 1):
        along = np.arange(lo[1 - axis], hi[1 - axis] + GRID_STEP_M, GRID_STEP_M)
        for at in np.arange(lo[axis], hi[axis] + GRID_SPACING_M, GRID_SPACING_M):
            pts = np.empty((len(along), 2))
            pts[:, axis], pts[:, 1 - axis] = at, along
            near = is_near(pts)
            # split into runs of consecutive points near the network
            edges = np.flatnonzero(np.diff(np.r_[0, near.astype(int), 0]))
            for start, stop in zip(edges[::2], edges[1::2]):
                if stop - start >= 2:
                    lines.append(pts[start:stop])
    return lines


def _nullable_floats(column):
    """Round a column of possibly-NULL doubles, keeping NULL/NaN as None."""
    return [
        None if v is None or np.isnan(v) else round(float(v), 1)
        for v in np.ma.filled(np.ma.masked_invalid(column.astype(float)), np.nan)
    ]


def _displacement_field(points, offsets):
    """Inverse-distance-weighted interpolation of node displacements."""

    def shift(query):
        out = np.empty_like(query)
        for i in range(0, len(query), 256):
            q = query[i : i + 256]
            d2 = ((q[:, None, :] - points[None, :, :]) ** 2).sum(axis=2)
            nearest = np.argpartition(d2, IDW_NEIGHBOURS, axis=1)[:, :IDW_NEIGHBOURS]
            w = 1 / (np.take_along_axis(d2, nearest, axis=1) + 1.0)
            out[i : i + 256] = (w[:, :, None] * offsets[nearest]).sum(1) / w.sum(1)[:, None]
        return out

    return shift


def _flat(points, origin):
    return (points - origin).round(DECIMALS).ravel().tolist()


def _dump(obj):
    return json.dumps(obj, separators=(",", ":")).encode()


store = _Store()


@router.get("/cost-space", response_description="Columnar geo + cost-space coordinates")
def get_cost_space(profile: str = DEFAULT_PROFILE, trees: bool = True, fountains: bool = True):
    """Node and edge positions in geographic and cost space, plus context landmarks.

    `profile` picks the heat-sensitivity profile the cost space is built for,
    `trees` and `fountains` whether tree shade and fountains soften the cost.

    Coordinates are flat [x0, y0, x1, y1, ...] lists in metres relative to
    `origin_lv95`. Edge paths are concatenated; `start_indices` gives the first
    vertex of each edge. Geo and cost paths have identical vertex counts.
    """
    if profile not in PROFILES:
        raise HTTPException(422, f"profile must be one of {', '.join(PROFILES)}")
    payload = store.get(profile, trees, fountains)
    if payload is None:
        raise HTTPException(503, store.error or "Layout not loaded")
    return Response(payload, media_type="application/json")


@router.post("/reload")
def reload():
    """Re-read the layout, e.g. after running build_layout.py."""
    store.load()
    if store.error:
        raise HTTPException(503, store.error)
    return {"ok": True}
