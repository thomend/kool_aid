"""Cost-space layout API: graph positions where edge length on screen = cost.

Serves geographic and cost-space coordinates side by side, in metres relative
to a common origin (Swiss LV95), so the frontend can morph between the two.
Data is columnar (flat coordinate lists) to keep the payload small and to
load straight into GPU buffers.

There is one layout per heat-sensitivity profile (see scripts/cost_model.py).

Built by scripts/build_layout.py (node_layout, layout_meta) and
scripts/fetch_context.py (context_lines, context_labels).
"""

import json

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
# A dead end with no other node within this distance is the loose end of a road
# cut off where the data ends (mostly at the city border), drawn faded.
STUB_ISOLATION_M = 150.0


class _Store:
    payloads: dict[str, bytes] = {}
    error: str | None = None

    def load(self):
        try:
            self.payloads = {
                p: _dump(_build(duckdb.connect(str(DB_PATH), read_only=True), p))
                for p in PROFILES
            }
            self.error = None
        except (duckdb.CatalogException, duckdb.BinderException, IndexError) as e:
            self.payloads = {}
            self.error = f"Layout tables missing or outdated, run scripts/build_layout.py ({e})"


def _build(con, profile):
    try:
        meta = con.sql(
            "SELECT * FROM layout_meta WHERE profile = $1", params=[profile]
        ).fetchdf().iloc[0].to_dict()
        nodes = con.sql("""
            SELECT n.id, n.node_type, n.degree, n.x, n.y, l.x AS lx, l.y AS ly
            FROM nodes n JOIN node_layout l ON l.node_id = n.id AND l.profile = $1
            ORDER BY n.id
        """, params=[profile]).fetchnumpy()
        try:
            edges = con.sql("""
                SELECT e.id, e.source, e.target, e.street_name, e.highway, e.is_pedestrian,
                       e.length_m, ec.pet_mean_c, COALESCE(ec.cost_m, e.length_m) AS walk_cost_m,
                       e.wkt
                FROM edges e LEFT JOIN edge_cost ec ON ec.edge_id = e.id AND ec.profile = $1
                WHERE e.component = 0
                ORDER BY e.id
            """, params=[profile]).fetchnumpy()
        except duckdb.CatalogException:
            # edge_cost not built yet (older build_layout.py run): fall back to length.
            edges = con.sql("""
                SELECT id, source, target, street_name, highway, is_pedestrian, length_m,
                       NULL AS pet_mean_c, length_m AS walk_cost_m, wkt
                FROM edges WHERE component = 0
                ORDER BY id
            """).fetchnumpy()
        try:
            leverage = dict(con.sql(
                "SELECT edge_id, leverage_pct FROM edge_leverage WHERE profile = $1",
                params=[profile],
            ).fetchall())
        except duckdb.CatalogException:
            leverage = {}  # scripts/build_leverage.py has not run
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

    stubs = _stubs(geo_xy, nodes["degree"], [index[s] for s in edges["source"]],
                   [index[t] for t in edges["target"]])
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

    all_pts = np.vstack([geo_xy, cost_xy]) - origin
    return {
        "meta": {
            k: (v.isoformat() if hasattr(v, "isoformat") else v) for k, v in meta.items()
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
            "walk_cost_m": edges["walk_cost_m"].round(1).tolist(),
            # percentile rank of where shade helps most, 0 where there is no leverage
            "leverage_pct": [round(leverage.get(e, 0.0), 1) for e in edges["id"].tolist()],
            "is_stub": stubs,
            "start_indices": starts[:-1],
            "geo": _flat(geo_paths, origin),
            "cost": _flat(cost_paths, origin),
        },
        "context": {"lines": context_lines, "labels": context_labels},
    }


def _stubs(geo_xy, degree, src, dst):
    """Per edge: is it a dead end whose loose end has no other node nearby?"""
    stubs = []
    for s, t in zip(src, dst):
        stub = False
        for end, other in ((s, t), (t, s)):
            if degree[end] == 1:
                d2 = ((geo_xy - geo_xy[end]) ** 2).sum(axis=1)
                d2[[end, other]] = np.inf
                stub = stub or d2.min() > STUB_ISOLATION_M**2
        stubs.append(bool(stub))
    return stubs


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
def get_cost_space(profile: str = DEFAULT_PROFILE):
    """Node and edge positions in geographic and cost space, plus context landmarks.

    `profile` picks the heat-sensitivity profile the cost space is built for.

    Coordinates are flat [x0, y0, x1, y1, ...] lists in metres relative to
    `origin_lv95`. Edge paths are concatenated; `start_indices` gives the first
    vertex of each edge. Geo and cost paths have identical vertex counts.
    """
    if profile not in PROFILES:
        raise HTTPException(422, f"profile must be one of {', '.join(PROFILES)}")
    if not store.payloads:
        raise HTTPException(503, store.error or "Layout not loaded")
    return Response(store.payloads[profile], media_type="application/json")


@router.post("/reload")
def reload():
    """Re-read the layout, e.g. after running build_layout.py."""
    store.load()
    if not store.payloads:
        raise HTTPException(503, store.error)
    return {"ok": True}
