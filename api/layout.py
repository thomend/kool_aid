"""Cost-space layout API: graph positions where edge length on screen = cost.

Serves geographic and cost-space coordinates side by side, in metres relative
to a common origin (Swiss LV95), so the frontend can morph between the two.
Data is columnar (flat coordinate lists) to keep the payload small and to
load straight into GPU buffers.

Built by scripts/build_layout.py (node_layout, layout_meta) and
scripts/fetch_context.py (context_lines, context_labels).
"""

import json

import duckdb
import numpy as np
import shapely
from fastapi import APIRouter, HTTPException, Response
from pyproj import Transformer

from .graph import DB_PATH

router = APIRouter(prefix="/api/layout", tags=["layout"])

TO_LV95 = Transformer.from_crs("EPSG:4326", "EPSG:2056", always_xy=True)
DECIMALS = 1  # 0.1 m
IDW_NEIGHBOURS = 8


class _Store:
    payload: bytes | None = None
    error: str | None = None

    def load(self):
        try:
            self.payload = _dump(_build(duckdb.connect(str(DB_PATH), read_only=True)))
            self.error = None
        except duckdb.CatalogException as e:
            self.payload = None
            self.error = f"Layout tables missing, run scripts/build_layout.py ({e})"


def _build(con):
    try:
        meta = con.sql("SELECT * FROM layout_meta").fetchdf().iloc[0].to_dict()
        nodes = con.sql("""
            SELECT n.id, n.node_type, n.degree, n.x, n.y, l.x AS lx, l.y AS ly
            FROM nodes n JOIN node_layout l ON l.node_id = n.id
            ORDER BY n.id
        """).fetchnumpy()
        edges = con.sql("""
            SELECT id, source, target, street_name, highway, is_pedestrian, length_m, wkt
            FROM edges WHERE component = 0
            ORDER BY id
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
            "start_indices": starts[:-1],
            "geo": _flat(geo_paths, origin),
            "cost": _flat(cost_paths, origin),
        },
        "context": {"lines": context_lines, "labels": context_labels},
    }


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
def get_cost_space():
    """Node and edge positions in geographic and cost space, plus context landmarks.

    Coordinates are flat [x0, y0, x1, y1, ...] lists in metres relative to
    `origin_lv95`. Edge paths are concatenated; `start_indices` gives the first
    vertex of each edge. Geo and cost paths have identical vertex counts.
    """
    if store.payload is None:
        raise HTTPException(503, store.error or "Layout not loaded")
    return Response(store.payload, media_type="application/json")


@router.post("/reload")
def reload():
    """Re-read the layout, e.g. after running build_layout.py."""
    store.load()
    if store.payload is None:
        raise HTTPException(503, store.error)
    return {"ok": True}
