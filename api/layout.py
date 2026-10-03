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
        warp = _load_warp(con, variant)
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

    # Edges: the geographic polyline, and the same polyline moved by the
    # cartogram warp (same vertices, so the two morph vertex by vertex).
    geo_parts, starts = [], [0]
    for wkt in edges["wkt"]:
        lonlat = shapely.get_coordinates(shapely.from_wkt(wkt))
        geo_parts.append(np.column_stack(TO_LV95.transform(lonlat[:, 0], lonlat[:, 1])))
        starts.append(starts[-1] + len(geo_parts[-1]))
    geo_paths = np.concatenate(geo_parts)
    cost_paths = warp(geo_paths)

    context_lines = []
    for name, wkt in lines:
        lonlat = shapely.get_coordinates(shapely.from_wkt(wkt))
        pts = np.column_stack(TO_LV95.transform(lonlat[:, 0], lonlat[:, 1]))
        context_lines.append(
            {"name": name, "geo": _flat(pts, origin), "cost": _flat(warp(pts), origin)}
        )
    context_labels = []
    for name, kind, lon, lat in labels:
        pt = np.array([TO_LV95.transform(lon, lat)])
        context_labels.append(
            {
                "name": name,
                "kind": kind,
                "geo": _flat(pt, origin),
                "cost": _flat(warp(pt), origin),
            }
        )

    is_near = _near_network(geo_xy)
    grid = [
        {"geo": _flat(line, origin), "cost": _flat(warp(line), origin)}
        for line in _grid_lines(geo_xy, is_near)
    ]
    cells = []
    for ring in _grid_cells(geo_xy, is_near):
        warped = warp(ring)
        cells.append({
            "geo": _flat(ring, origin),
            "cost": _flat(warped, origin),
            # > 1: the area feels bigger than on the map, < 1: smaller
            "area_ratio": round(float(_area(warped) / _area(ring)), 3),
        })

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
        "context": {"lines": context_lines, "labels": context_labels, "grid": grid, "cells": cells},
    }


def _near_network(nodes_xy):
    """A test for points within about GRID_REACH_M of a node."""
    # cells of GRID_STEP_M with a node, grown by GRID_REACH_M
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

    return is_near


def _grid_lines(nodes_xy, is_near):
    """A regular grid over the network, as polylines cut where they leave it.

    Lines run on GRID_SPACING_M multiples (LV95), with a vertex every
    GRID_STEP_M so they can bend when displaced into cost space.
    """
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


def _grid_cells(nodes_xy, is_near):
    """The cells between the grid lines whose centre is near the network, as rings.

    Each side has a vertex every GRID_STEP_M (no repeated closing vertex), so
    the cell bends with the warp like the grid lines around it.
    """
    steps = np.arange(0, GRID_SPACING_M, GRID_STEP_M)
    side = len(steps)
    unit = np.concatenate([
        np.c_[steps, np.zeros(side)],
        np.c_[np.full(side, GRID_SPACING_M), steps],
        np.c_[GRID_SPACING_M - steps, np.full(side, GRID_SPACING_M)],
        np.c_[np.zeros(side), GRID_SPACING_M - steps],
    ])
    lo = np.floor(nodes_xy.min(axis=0) / GRID_SPACING_M) * GRID_SPACING_M
    hi = np.ceil(nodes_xy.max(axis=0) / GRID_SPACING_M) * GRID_SPACING_M
    corners = np.array([
        (x, y)
        for x in np.arange(lo[0], hi[0], GRID_SPACING_M)
        for y in np.arange(lo[1], hi[1], GRID_SPACING_M)
    ])
    corners = corners[is_near(corners + GRID_SPACING_M / 2)]
    return [unit + corner for corner in corners]


def _area(ring):
    """Shoelace area of a ring (no repeated closing vertex)."""
    x, y = ring[:, 0], ring[:, 1]
    return 0.5 * abs(np.dot(x, np.roll(y, -1)) - np.dot(y, np.roll(x, -1)))


def _nullable_floats(column):
    """Round a column of possibly-NULL doubles, keeping NULL/NaN as None."""
    return [
        None if v is None or np.isnan(v) else round(float(v), 1)
        for v in np.ma.filled(np.ma.masked_invalid(column.astype(float)), np.nan)
    ]


def _load_warp(con, variant):
    """The cartogram warp of a variant (layout_warp), as a function of LV95 points.

    Bilinear interpolation of the warped lattice, as cartogram.Warp.apply in
    scripts/ (the API doesn't import the pipeline).
    """
    x0, y0, step, nx, ny, moved = con.sql("""
        SELECT x0, y0, step_m, nx, ny, moved FROM layout_warp
        WHERE profile = $1 AND trees = $2 AND fountains = $3
    """, params=variant).fetchone()
    lattice = np.asarray(moved, dtype=float).reshape(nx, ny, 2)

    def warp(points):
        gx = np.clip((points[:, 0] - x0) / step, 0, nx - 1.000001)
        gy = np.clip((points[:, 1] - y0) / step, 0, ny - 1.000001)
        i, j = gx.astype(int), gy.astype(int)
        fx, fy = (gx - i)[:, None], (gy - j)[:, None]
        return (
            lattice[i, j] * (1 - fx) * (1 - fy)
            + lattice[i + 1, j] * fx * (1 - fy)
            + lattice[i, j + 1] * (1 - fx) * fy
            + lattice[i + 1, j + 1] * fx * fy
        )

    return warp


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
