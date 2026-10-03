"""Compute the cost-space layout of the walkable graph.

Treats the main component as an elastic network: every edge is a spring whose
rest length is its walking cost, and every node is gently pulled toward its
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

Writes:
  node_layout   node_id, x, y   (Swiss LV95 metres, same frame as nodes.x/y)
  layout_meta   one row of parameters and quality measures

Usage:
    python scripts/build_layout.py [--db data/basel.duckdb] [--alpha 0.02]
"""

import argparse
import time
from pathlib import Path

import duckdb
import numpy as np


def edge_cost(length_m):
    """Walking cost of an edge in metres. Only length for now; the cost model goes here."""
    return length_m


def load_graph(con):
    nodes = con.sql("SELECT id, x, y FROM nodes WHERE component = 0 ORDER BY id").fetchnumpy()
    edges = con.sql("""
        SELECT source, target, length_m FROM edges
        WHERE component = 0 AND source <> target
    """).fetchnumpy()
    index = {node_id: i for i, node_id in enumerate(nodes["id"])}
    src = np.array([index[s] for s in edges["source"]])
    dst = np.array([index[t] for t in edges["target"]])
    return nodes["id"], np.column_stack([nodes["x"], nodes["y"]]), src, dst, edges["length_m"]


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
    started = time.time()

    con = duckdb.connect(str(args.db))
    node_ids, geo, src, dst, length = load_graph(con)
    a, b, cost = unique_edges(src, dst, edge_cost(length))

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

    con.execute("""
        CREATE OR REPLACE TABLE node_layout (node_id BIGINT PRIMARY KEY, x DOUBLE, y DOUBLE)
    """)
    con.execute(
        """INSERT INTO node_layout
           SELECT unnest($1) AS node_id, unnest($2) AS x, unnest($3) AS y""",
        [node_ids.tolist(), pos[:, 0].tolist(), pos[:, 1].tolist()],
    )
    con.execute("""
        CREATE OR REPLACE TABLE layout_meta (
            built_at TIMESTAMP,
            cost VARCHAR,                 -- what edge_cost() is based on
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
    con.execute(
        "INSERT INTO layout_meta VALUES (now(), 'length_m', ?, ?, ?, ?, ?, ?, ?, ?)",
        [args.alpha, iterations, *quality.values()],
    )
    con.close()

    print(
        f"Laid out {len(node_ids)} nodes in {time.time() - started:.1f}s ({iterations} iterations). "
        f"Edge stretch median {quality['edge_stretch_median']:.3f} "
        f"(p5 {quality['edge_stretch_p05']:.3f}, p95 {quality['edge_stretch_p95']:.3f}); "
        f"displacement median {quality['displacement_median_m']:.0f} m, "
        f"p95 {quality['displacement_p95_m']:.0f} m, max {quality['displacement_max_m']:.0f} m"
    )


if __name__ == "__main__":
    main()
