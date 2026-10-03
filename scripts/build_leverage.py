"""Estimate where shade would help walkers most: the leverage of each edge, in DuckDB.

A heat map shows where it is hot. This shows where heat is hot *and* hard to avoid on
everyday walks, which a raster cannot: a hot street with a shaded parallel street scores
low, a hot link that many walks have to use scores high.

Method (offline, a few seconds per hundred start points):
  1. Simulate walks: from SOURCES random start nodes of the main network, every node within
     MAX_TRIP_M along the shortest path is a destination (one walk per start-destination pair).
  2. Route every walk twice per heat-sensitivity profile: shortest (by length) and coolest
     (by the profile's cost from build_layout.py, i.e. people avoid heat where they can).
  3. Per edge and profile:
       trips_shortest  walks whose shortest route uses the edge (where people want to go)
       trips_coolest   walks whose coolest route still uses the edge (heat they cannot avoid)
       surcharge_m     cost_m - length_m, the heat surcharge of walking the edge
       leverage        trips_coolest * surcharge_m / walks: the heat surcharge per simulated
                       walk that shading the edge (cost back to its length) would remove
       leverage_pct    percentile rank of leverage among edges with leverage > 0 (0-100)
     The first-order estimate ignores walks that would switch onto the edge once shaded.

Creates two tables (rerun with --replace after build_layout.py rebuilt edge_cost):
  edge_leverage  profile, edge_id, trips_shortest, trips_coolest, surcharge_m, leverage,
                 leverage_pct; main-network edges only
  leverage_meta  one row: built_at, sources, max_trip_m, walks

Usage:
    python scripts/build_leverage.py [--db data/basel.duckdb] [--sources 1000] [--replace]
"""

import argparse
import heapq
import time
from pathlib import Path

import duckdb
import numpy as np

from cost_model import PROFILES

SOURCES = 1000
MAX_TRIP_M = 2000.0  # ~25 min on foot
SEED = 0


def table_exists(con, name):
    return con.execute(
        "SELECT COUNT(*) FROM information_schema.tables WHERE table_name = ?", [name]
    ).fetchone()[0] > 0


def load_network(con):
    """Main-network edges (without self-loops) with length and cost per profile."""
    edges = con.sql("""
        SELECT id, source, target, length_m FROM edges
        WHERE component = 0 AND source <> target
        ORDER BY id
    """).fetchnumpy()
    costs = con.sql("SELECT profile, edge_id, cost_m FROM edge_cost").fetchall()
    cost_of = {(p, e): c for p, e, c in costs}
    cost = {
        p: np.array([cost_of.get((p, e), length) for e, length in zip(edges["id"], edges["length_m"])])
        for p in PROFILES
    }
    nodes, inverse = np.unique(np.r_[edges["source"], edges["target"]], return_inverse=True)
    n_edges = len(edges["id"])
    src, dst = inverse[:n_edges], inverse[n_edges:]
    # plain Python ints and lists: much faster than numpy scalars in the Dijkstra loop
    adj = [[] for _ in nodes]
    for i, (s, t) in enumerate(zip(src.tolist(), dst.tolist())):
        adj[s].append((t, i))
        adj[t].append((s, i))
    return edges["id"], edges["length_m"], cost, adj


def dijkstra(adj, weight, source, cutoff=None, targets=None):
    """Shortest-path tree from source, in settling order.

    Stops beyond `cutoff`, or once every node in `targets` is settled.
    Returns the settled nodes and, per settled node, its parent node and edge.
    """
    dist = {source: 0.0}
    parent = {source: (-1, -1)}
    order = []
    left = len(targets) if targets is not None else None
    heap = [(0.0, source)]
    while heap:
        d, u = heapq.heappop(heap)
        if d > dist[u]:
            continue
        if cutoff is not None and d > cutoff:
            break
        order.append(u)
        if left is not None and u in targets:
            left -= 1
            if left == 0:
                break
        for v, e in adj[u]:
            nd = d + weight[e]
            if nd < dist.get(v, np.inf):
                dist[v] = nd
                parent[v] = (u, e)
                heapq.heappush(heap, (nd, v))
    return order, parent


def count_trips(order, parent, targets, trips):
    """Add to each tree edge the number of target nodes whose route passes it."""
    below = {}
    for u in reversed(order):
        n = below.get(u, 0) + (u in targets)
        p, e = parent[u]
        if e >= 0 and n:
            trips[e] += n
            below[p] = below.get(p, 0) + n


def simulate(length, cost, adj, sources, max_trip_m):
    """Trip counts per edge on shortest and (per profile) coolest routes."""
    n_edges = len(length)
    trips_shortest = np.zeros(n_edges)
    trips_coolest = {p: np.zeros(n_edges) for p in PROFILES}
    walks = 0
    weight = {"length": length.tolist(), **{p: cost[p].tolist() for p in PROFILES}}
    for k, source in enumerate(sources, 1):
        order, parent = dijkstra(adj, weight["length"], source, cutoff=max_trip_m)
        targets = set(order) - {source}
        if not targets:
            continue
        walks += len(targets)
        count_trips(order, parent, targets, trips_shortest)
        for p in PROFILES:
            order, parent = dijkstra(adj, weight[p], source, targets=targets)
            count_trips(order, parent, targets, trips_coolest[p])
        if k % 200 == 0:
            print(f"  {k}/{len(sources)} start points, {walks:,} walks")
    return trips_shortest, trips_coolest, walks


def percentile_rank(values):
    """0-100 rank among positive values; 0 for the rest."""
    pct = np.zeros(len(values))
    positive = values > 0
    ranks = values[positive].argsort().argsort()
    pct[positive] = 100 * (ranks + 1) / max(positive.sum(), 1)
    return pct


def write_db(con, edge_ids, length, cost, trips_shortest, trips_coolest, walks, args):
    con.execute("DROP TABLE IF EXISTS edge_leverage")
    con.execute("DROP TABLE IF EXISTS leverage_meta")
    con.execute("""
        CREATE TABLE edge_leverage (
            profile VARCHAR,        -- heat-sensitivity profile, see cost_model.py
            edge_id BIGINT,         -- edges.id
            trips_shortest INTEGER, -- simulated walks whose shortest route uses the edge
            trips_coolest INTEGER,  -- ... whose coolest route still uses it
            surcharge_m DOUBLE,     -- cost_m - length_m
            leverage DOUBLE,        -- trips_coolest * surcharge_m / walks
            leverage_pct DOUBLE,    -- percentile rank of leverage, 0-100
            PRIMARY KEY (profile, edge_id)
        )
    """)
    con.execute("""
        CREATE TABLE leverage_meta (
            built_at TIMESTAMP,
            sources INTEGER,    -- simulated start points
            max_trip_m DOUBLE,  -- longest walk (shortest-path length)
            walks BIGINT        -- simulated start-destination pairs
        )
    """)
    for p in PROFILES:
        surcharge = cost[p] - length
        leverage = trips_coolest[p] * surcharge / max(walks, 1)
        con.execute(
            """INSERT INTO edge_leverage
               SELECT $1, unnest($2), unnest($3), unnest($4), unnest($5), unnest($6), unnest($7)""",
            [
                p,
                edge_ids.tolist(),
                trips_shortest.astype(int).tolist(),
                trips_coolest[p].astype(int).tolist(),
                surcharge.tolist(),
                leverage.tolist(),
                percentile_rank(leverage).tolist(),
            ],
        )
    con.execute(
        "INSERT INTO leverage_meta VALUES (now(), ?, ?, ?)", [args.sources, args.max_trip_m, walks]
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--db", type=Path, default=Path("data/basel.duckdb"))
    parser.add_argument("--sources", type=int, default=SOURCES, help="simulated start points")
    parser.add_argument("--max-trip-m", type=float, default=MAX_TRIP_M)
    parser.add_argument("--replace", action="store_true",
                        help="recompute edge_leverage if it already exists")
    args = parser.parse_args()

    con = duckdb.connect(str(args.db))
    if table_exists(con, "edge_leverage") and not args.replace:
        raise SystemExit(
            "Table edge_leverage already exists. Rerun with --replace to recompute it "
            "(needed after build_layout.py rebuilt edge_cost)."
        )
    started = time.time()
    edge_ids, length, cost, adj = load_network(con)
    rng = np.random.default_rng(SEED)
    sources = rng.choice(len(adj), size=min(args.sources, len(adj)), replace=False).tolist()
    trips_shortest, trips_coolest, walks = simulate(length, cost, adj, sources, args.max_trip_m)
    write_db(con, edge_ids, length, cost, trips_shortest, trips_coolest, walks, args)
    con.close()

    print(f"Simulated {walks:,} walks from {len(sources)} start points "
          f"in {time.time() - started:.0f}s; wrote edge_leverage and leverage_meta to {args.db}")


if __name__ == "__main__":
    main()
