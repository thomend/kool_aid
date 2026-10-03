"""Compute the cost-space layout of the walkable graph.

Treats the main component as an elastic network: every edge is a spring whose
rest length is its walking cost relative to the city (cost divided by the
length-weighted median heat factor, so the city as a whole keeps its size:
hotter-than-typical streets stretch, cooler ones shrink), and every node is gently pulled toward its
geographic position so the city stays recognisable. Minimises

    sum over edges   w_ij (|p_i - p_j| - c_ij)^2       edge length on screen = cost
  + alpha * sum over nodes  W_i |p_i - g_i|^2          stay near geography

with w_ij = 1/c_ij^2 and W_i the summed edge weight of node i. Solved by stress
majorization starting from the geographic positions g, so the layout never
flips or rotates. Expensive edges push their surroundings apart; cheap ones
pull them together.

(Shortest-path "pivot" terms that make all pairwise distances match path cost
were tried too: they inflate the whole city and fling dead ends outward,
which makes the view unreadable.)

One layout is computed per heat-sensitivity profile (cost_model.PROFILES).

Writes:
  node_layout   profile, node_id, x, y     (Swiss LV95 metres, same frame as nodes.x/y)
  layout_meta   one row of parameters and quality measures per profile
  edge_cost     profile, edge_id, pet_mean_c, cost_m, for every main-component edge
                (so the API can colour by, and the frontend inspect, the same
                cost that shaped the layout, without recomputing it)

Usage:
    python scripts/build_layout.py [--db data/basel.duckdb] [--alpha 0.02]
"""

import argparse
import time
from pathlib import Path

import duckdb
import numpy as np

from cost_model import PROFILES, heat_factor, median_heat_factor


def edge_cost(length_m, heat_excess_sq_mean, scale_c):
    """Walking cost of an edge in metres: its length stretched by heat stress."""
    return length_m * heat_factor(heat_excess_sq_mean, scale_c)


def load_edge_heat(con, edge_ids):
    """PET and mean squared heat excess per edge id, see cost_model.py.

    PET is NaN where edge_stadtklima has no sample (no raster coverage). Those
    edges take the heat excess of their neighbours, spreading inward over a
    few rounds; any left take the median.
    """
    n = len(edge_ids)
    try:
        heat = con.sql(
            "SELECT edge_id, pet_mean_c, heat_excess_sq_mean FROM edge_stadtklima"
        ).fetchnumpy()
    except duckdb.CatalogException:
        return np.full(n, np.nan), np.zeros(n)
    except duckdb.BinderException:
        raise SystemExit(
            "edge_stadtklima has no heat_excess_sq_mean; rerun "
            "scripts/join_stadtklima_edges.py --replace"
        )
    index = {e: i for i, e in enumerate(heat["edge_id"])}
    rows = np.array([index.get(e, -1) for e in edge_ids])
    found = rows >= 0

    def column(name):
        values = np.full(n, np.nan)
        values[found] = np.ma.filled(heat[name].astype(float), np.nan)[rows[found]]
        return values

    return column("pet_mean_c"), fill_from_neighbours(con, edge_ids, column("heat_excess_sq_mean"))


def fill_from_neighbours(con, edge_ids, values, rounds=10):
    missing = np.isnan(values)
    if not missing.any():
        return values
    ends = con.sql("SELECT id, source, target FROM edges").fetchnumpy()
    ends_by_id = {e: (s, t) for e, s, t in zip(ends["id"], ends["source"], ends["target"])}
    src = np.array([ends_by_id[e][0] for e in edge_ids])
    dst = np.array([ends_by_id[e][1] for e in edge_ids])
    nodes, inverse = np.unique(np.r_[src, dst], return_inverse=True)
    s, d = inverse[: len(src)], inverse[len(src):]
    values = values.copy()
    for _ in range(rounds):
        known = ~np.isnan(values)
        v = np.where(known, values, 0.0)
        total = np.bincount(s, v, len(nodes)) + np.bincount(d, v, len(nodes))
        count = np.bincount(s, known, len(nodes)) + np.bincount(d, known, len(nodes))
        t, c = total[s] + total[d], count[s] + count[d]
        fill = ~known & (c > 0)
        if not fill.any():
            break
        values[fill] = t[fill] / c[fill]
    values[np.isnan(values)] = np.nanmedian(values)
    return values


def load_graph(con):
    nodes = con.sql("SELECT id, x, y FROM nodes WHERE component = 0 ORDER BY id").fetchnumpy()
    edges = con.sql("""
        SELECT id, source, target, length_m FROM edges
        WHERE component = 0 AND source <> target
    """).fetchnumpy()
    index = {node_id: i for i, node_id in enumerate(nodes["id"])}
    src = np.array([index[s] for s in edges["source"]])
    dst = np.array([index[t] for t in edges["target"]])
    _, heat = load_edge_heat(con, edges["id"])
    return nodes["id"], np.column_stack([nodes["x"], nodes["y"]]), src, dst, edges["length_m"], heat


def unique_edges(src, dst, cost):
    """Collapse parallel edges to the cheapest one per node pair."""
    a, b = np.minimum(src, dst), np.maximum(src, dst)
    order = np.lexsort((cost, b, a))
    a, b, cost = a[order], b[order], cost[order]
    first = np.ones(len(a), bool)
    first[1:] = (a[1:] != a[:-1]) | (b[1:] != b[:-1])
    return a[first], b[first], cost[first]


def majorize(geo, a, b, cost, alpha, max_iterations, tol=1e-3):
    """Localized stress majorization of the edge springs plus the geographic pull."""
    n = len(geo)
    I, J = np.r_[a, b], np.r_[b, a]
    D = np.r_[cost, cost]
    W = 1 / np.maximum(D, 1.0) ** 2  # floor at 1 m so tiny edges don't dominate
    w_sum = np.bincount(I, weights=W, minlength=n)
    anchor = alpha * w_sum
    denom = w_sum + anchor

    pos = geo.copy()
    for iteration in range(1, max_iterations + 1):
        delta = pos[I] - pos[J]
        dist = np.maximum(np.linalg.norm(delta, axis=1), 1e-9)
        target = pos[J] + (D / dist)[:, None] * delta
        num = np.column_stack(
            [np.bincount(I, weights=W * target[:, c], minlength=n) for c in (0, 1)]
        )
        new = (num + anchor[:, None] * geo) / denom[:, None]
        move = np.linalg.norm(new - pos, axis=1).mean()
        pos = new
        if move < tol:
            break
    return pos, iteration


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--db", type=Path, default=Path("data/basel.duckdb"))
    parser.add_argument("--alpha", type=float, default=0.02,
                        help="pull toward geography (0 = edges only, larger = closer to the map)")
    parser.add_argument("--max-iterations", type=int, default=3000)
    args = parser.parse_args()

    con = duckdb.connect(str(args.db))
    node_ids, geo, src, dst, length, heat = load_graph(con)
    # Every main-component edge's cost, including self-loops (dropped from the
    # spring layout but still walkable and worth colouring/inspecting).
    all_edges = con.sql(
        "SELECT id, length_m FROM edges WHERE component = 0 ORDER BY id"
    ).fetchnumpy()
    all_pet, all_heat = load_edge_heat(con, all_edges["id"])
    all_pet = [None if np.isnan(v) else v for v in all_pet.tolist()]

    con.execute("""
        CREATE OR REPLACE TABLE node_layout (
            profile VARCHAR, node_id BIGINT, x DOUBLE, y DOUBLE,
            PRIMARY KEY (profile, node_id)
        )
    """)
    con.execute("""
        CREATE OR REPLACE TABLE layout_meta (
            profile VARCHAR PRIMARY KEY,  -- heat-sensitivity profile, see cost_model.py
            built_at TIMESTAMP,
            cost VARCHAR,                 -- what edge_cost() is based on
            heat_factor_median DOUBLE,    -- layout edge length = cost / this
            alpha DOUBLE,
            iterations INTEGER,
            edge_stretch_median DOUBLE,   -- on-screen edge length / cost (1 = exact)
            edge_stretch_p05 DOUBLE,
            edge_stretch_p95 DOUBLE,
            displacement_median_m DOUBLE, -- how far nodes moved from geography
            displacement_p95_m DOUBLE,
            displacement_max_m DOUBLE
        )
    """)
    con.execute("""
        CREATE OR REPLACE TABLE edge_cost (
            profile VARCHAR,
            edge_id BIGINT,
            pet_mean_c DOUBLE,  -- NULL where edge_stadtklima has no sample
            cost_m DOUBLE,      -- edge_cost() for this profile
            PRIMARY KEY (profile, edge_id)
        )
    """)

    for profile, scale in PROFILES.items():
        started = time.time()
        median = median_heat_factor(heat_factor(all_heat, scale), all_edges["length_m"])
        a, b, cost = unique_edges(src, dst, edge_cost(length, heat, scale) / median)
        pos, iterations = majorize(geo, a, b, cost, args.alpha, args.max_iterations)

        stretch = np.linalg.norm(pos[a] - pos[b], axis=1) / np.maximum(cost, 1e-6)
        displacement = np.linalg.norm(pos - geo, axis=1)
        quality = {
            "edge_stretch_median": float(np.median(stretch)),
            "edge_stretch_p05": float(np.percentile(stretch, 5)),
            "edge_stretch_p95": float(np.percentile(stretch, 95)),
            "displacement_median_m": float(np.median(displacement)),
            "displacement_p95_m": float(np.percentile(displacement, 95)),
            "displacement_max_m": float(displacement.max()),
        }

        con.execute(
            """INSERT INTO node_layout
               SELECT $1, unnest($2) AS node_id, unnest($3) AS x, unnest($4) AS y""",
            [profile, node_ids.tolist(), pos[:, 0].tolist(), pos[:, 1].tolist()],
        )
        con.execute(
            "INSERT INTO layout_meta VALUES (?, now(), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            [
                profile,
                f"length_m * (1 + (max(PET - 29 C, 0) / {scale:g} C)^2), mean along the edge",
                median,
                args.alpha,
                iterations,
                *quality.values(),
            ],
        )
        con.execute(
            """INSERT INTO edge_cost
               SELECT $1, unnest($2) AS edge_id, unnest($3) AS pet_mean_c, unnest($4) AS cost_m""",
            [
                profile,
                all_edges["id"].tolist(),
                all_pet,
                edge_cost(all_edges["length_m"], all_heat, scale).tolist(),
            ],
        )

        print(
            f"[{profile}] Median heat factor {median:.2f}. Laid out {len(node_ids)} nodes in {time.time() - started:.1f}s "
            f"({iterations} iterations). Edge stretch median {quality['edge_stretch_median']:.3f} "
            f"(p5 {quality['edge_stretch_p05']:.3f}, p95 {quality['edge_stretch_p95']:.3f}); "
            f"displacement median {quality['displacement_median_m']:.0f} m, "
            f"p95 {quality['displacement_p95_m']:.0f} m, max {quality['displacement_max_m']:.0f} m"
        )
    con.close()


if __name__ == "__main__":
    main()
