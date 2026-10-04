"""Compute the cost space of the walkable graph: Basel as it feels on a hot afternoon.

A density cartogram (cartogram.py, Gastner & Newman's diffusion method) grows
every area by how much harder it is to walk than a typical metre without trees
and fountains (the fixed reference), and shrinks it where it is easier:

    target area = (local heat factor / reference) ^ EXAGGERATION

The local heat factor is the length-weighted mean over the edges nearby (log
scale, Gaussian blur of SMOOTHING_M), fading to neutral where the network is
sparse, so rivers and parks keep their size. EXAGGERATION makes the effect
visible: as walked, areas would change by at most ~1.5x. The warp is smooth and
never folds; streets, rivers, labels and the background grid all move with it.

One cartogram is computed per heat-sensitivity profile (cost_model.PROFILES)
and factor variant (tree shade, fountains and slope each on or off).

Writes:
  edge_heat     edge_id, pet_mean_c, heat_excess_sq_mean, shade_share, fountain_share,
                slope_excess for every main-component edge: the ingredients of the cost, from
                which the frontend computes it for any profile and variant
  cost_model    one row: the constants of the formula (cost_model.py)
  layout_warp   profile, trees, fountains, slope and the warped lattice (WARP_STEP_M), from
                which the API moves any point into cost space
  layout_meta   one row of parameters and quality measures per profile and variant

Usage:
    python scripts/build_layout.py [--db data/basel.duckdb] [--exaggeration 4]
"""

import argparse
import time
from pathlib import Path

import duckdb
import numpy as np

from cartogram import Warp, diffuse, gaussian_blur
from cost_model import (
    FOUNTAIN_EFFECT,
    PET_THRESHOLD_C,
    PROFILES,
    SHADE_EFFECT,
    SLOPE_WEIGHT,
    heat_factor,
    median_heat_factor,
    relieved_heat_excess_sq,
    slope_factor,
)

# Factor variants: (tree shade, fountains, slope) each counted or not
VARIANTS = [(t, f, s) for t in (False, True) for f in (False, True) for s in (False, True)]

EXAGGERATION = 4.0  # target area = ratio ** this; at 4, the hottest blocks grow ~2-3x
CELL_M = 50.0  # cartogram grid
GRID_SIZE = 512  # cells per side (25.6 km), a wide neutral margin around Basel
SMOOTHING_M = 125.0  # neighbourhood scale of the heat field
WARP_MARGIN_M = 3000.0  # stored warp reaches this far beyond the network
WARP_STEP_M = 100.0  # spacing of the stored warp lattice
BLOCK_M = 250.0  # block size for the area statistics


def edge_factor(heat, profile, trees, fountains, slope):
    """Cost per metre of each edge for a profile and factor variant.

    heat is (heat_excess_sq_mean, shade_share, fountain_share, slope_excess) per edge.
    """
    excess, shade, fountain, slope_excess = heat
    return slope_factor(slope_excess * slope, SLOPE_WEIGHT[profile]) * heat_factor(
        relieved_heat_excess_sq(excess, shade * trees, fountain * fountains), PROFILES[profile]
    )


def load_edge_heat(con, edge_ids):
    """PET and (heat excess, shade share, fountain share, slope excess) per edge id.

    PET is NaN where edge_stadtklima has no sample (no raster coverage). Those
    edges take the heat excess of their neighbours, spreading inward over a
    few rounds; any left take the median. Shade, fountains and slope are 0
    where their tables have no row.
    """
    n = len(edge_ids)
    try:
        heat = con.sql(
            "SELECT edge_id, pet_mean_c, heat_excess_sq_mean FROM edge_stadtklima"
        ).fetchnumpy()
    except duckdb.CatalogException:
        return np.full(n, np.nan), tuple(np.zeros(n) for _ in range(4))
    except duckdb.BinderException:
        raise SystemExit(
            "edge_stadtklima has no heat_excess_sq_mean; rerun "
            "scripts/join_stadtklima_edges.py --replace"
        ) from None
    index = {e: i for i, e in enumerate(heat["edge_id"])}
    rows = np.array([index.get(e, -1) for e in edge_ids])
    found = rows >= 0

    def column(name):
        values = np.full(n, np.nan)
        values[found] = np.ma.filled(heat[name].astype(float), np.nan)[rows[found]]
        return values

    excess = fill_from_neighbours(con, edge_ids, column("heat_excess_sq_mean"))
    shade = load_edge_value(con, edge_ids, "edge_trees", "shade_share", "join_trees_edges.py")
    fountain = load_edge_value(
        con, edge_ids, "edge_fountains", "fountain_share", "join_fountains_edges.py"
    )
    slope = load_edge_value(con, edge_ids, "edge_slope", "slope_excess", "join_slope_edges.py")
    return column("pet_mean_c"), (excess, shade, fountain, slope)


def load_edge_value(con, edge_ids, table, column, script):
    """A value per edge id from `table`; 0 where it has no row or doesn't exist."""
    try:
        rows = con.sql(f"SELECT edge_id, {column} FROM {table}").fetchnumpy()
    except (duckdb.CatalogException, duckdb.BinderException):
        print(f"No {table}.{column} (run scripts/{script}): costs ignore it")
        return np.zeros(len(edge_ids))
    by_id = dict(zip(rows["edge_id"], np.ma.filled(rows[column].astype(float), 0.0), strict=True))
    return np.array([by_id.get(e, 0.0) for e in edge_ids])


def fill_from_neighbours(con, edge_ids, values, rounds=10):
    """Replace NaNs by the mean of the edges sharing a node, then by the median."""
    if not np.isnan(values).any():
        return values
    ends = con.sql("SELECT id, source, target FROM edges").fetchnumpy()
    ends_by_id = {
        e: (s, t) for e, s, t in zip(ends["id"], ends["source"], ends["target"], strict=True)
    }
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
    """Main-component node positions (LV95) and edges (end indices, length, heat), no loops."""
    nodes = con.sql("SELECT id, x, y FROM nodes WHERE component = 0 ORDER BY id").fetchnumpy()
    edges = con.sql("""
        SELECT id, source, target, length_m FROM edges
        WHERE component = 0 AND source <> target
    """).fetchnumpy()
    index = {node_id: i for i, node_id in enumerate(nodes["id"])}
    src = np.array([index[s] for s in edges["source"]])
    dst = np.array([index[t] for t in edges["target"]])
    _, heat = load_edge_heat(con, edges["id"])
    return np.column_stack([nodes["x"], nodes["y"]]), src, dst, edges["length_m"], heat


def heat_density(origin, mid_cell, length, ratio, exaggeration):
    """Cartogram density per grid cell: exaggerated local heat ratio, 1 where sparse."""
    weight = np.zeros((GRID_SIZE, GRID_SIZE))
    log_sum = np.zeros((GRID_SIZE, GRID_SIZE))
    np.add.at(weight, tuple(mid_cell.T), length)
    np.add.at(log_sum, tuple(mid_cell.T), length * np.log(ratio))
    weight = gaussian_blur(weight, SMOOTHING_M / CELL_M)
    log_sum = gaussian_blur(log_sum, SMOOTHING_M / CELL_M)
    # fade to neutral where the network is sparse (a quarter of the cells near
    # the network have less weight than this)
    w0 = np.percentile(weight[weight > weight.max() * 1e-3], 25)
    log_ratio = log_sum / np.maximum(weight, 1e-9) * (weight / (weight + w0))
    return np.exp(exaggeration * log_ratio)


def stored_warp(origin, moved_cells, bounds):
    """The cartogram lattice in metres, cropped around the network and thinned."""
    every = int(WARP_STEP_M / CELL_M)
    lo = np.floor((bounds[0] - WARP_MARGIN_M - origin) / WARP_STEP_M).astype(int) * every
    hi = np.ceil((bounds[1] + WARP_MARGIN_M - origin) / WARP_STEP_M).astype(int) * every
    lo, hi = np.maximum(lo, 0), np.minimum(hi, GRID_SIZE)
    moved = moved_cells[lo[0]:hi[0] + 1:every, lo[1]:hi[1] + 1:every] * CELL_M + origin
    x0, y0 = origin + lo * CELL_M
    return Warp(float(x0), float(y0), WARP_STEP_M, moved)


def block_area_ratios(warp, geo):
    """Area change of the BLOCK_M blocks that contain at least 5 nodes."""
    cell = np.floor(geo / BLOCK_M).astype(int)
    blocks, counts = np.unique(cell, axis=0, return_counts=True)
    blocks = blocks[counts >= 5] * BLOCK_M
    steps = np.linspace(0, BLOCK_M, 6)[:-1]
    ring = np.concatenate([  # block outline, 5 vertices per side
        np.c_[steps, np.zeros(5)], np.c_[np.full(5, BLOCK_M), steps],
        np.c_[BLOCK_M - steps, np.full(5, BLOCK_M)], np.c_[np.zeros(5), BLOCK_M - steps],
    ])
    moved = warp.apply((blocks[:, None, :] + ring[None]).reshape(-1, 2)).reshape(len(blocks), -1, 2)
    x, y = moved[..., 0], moved[..., 1]
    area = 0.5 * np.abs(np.sum(x * np.roll(y, -1, axis=1) - y * np.roll(x, -1, axis=1), axis=1))
    return area / BLOCK_M**2


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--db", type=Path, default=Path("data/basel.duckdb"))
    parser.add_argument("--exaggeration", type=float, default=EXAGGERATION,
                        help="target area = (heat ratio) ** this (1 = as walked)")
    args = parser.parse_args()

    con = duckdb.connect(str(args.db))
    geo, src, dst, length, heat = load_graph(con)
    # Every main-component edge, including self-loops (not part of the density
    # but still walkable and worth colouring/inspecting).
    all_edges = con.sql(
        "SELECT id, length_m FROM edges WHERE component = 0 ORDER BY id"
    ).fetchnumpy()
    all_pet, all_heat = load_edge_heat(con, all_edges["id"])

    con.execute("""
        CREATE OR REPLACE TABLE edge_heat (
            edge_id BIGINT PRIMARY KEY,
            pet_mean_c DOUBLE,           -- NULL where edge_stadtklima has no sample
            heat_excess_sq_mean DOUBLE,  -- from neighbours where PET is missing
            shade_share DOUBLE,          -- 0 without edge_trees
            fountain_share DOUBLE,       -- 0 without edge_fountains
            slope_excess DOUBLE          -- 0 without edge_slope
        )
    """)
    con.execute(
        """INSERT INTO edge_heat
           SELECT unnest($1), unnest($2), unnest($3), unnest($4), unnest($5), unnest($6)""",
        [
            all_edges["id"].tolist(),
            [None if np.isnan(v) else v for v in all_pet.tolist()],
            *(column.tolist() for column in all_heat),
        ],
    )
    con.execute("""
        CREATE OR REPLACE TABLE cost_model (
            pet_threshold_c DOUBLE,  -- heat counts above this PET
            shade_effect DOUBLE,     -- share of the heat excess full tree shade avoids
            fountain_effect DOUBLE   -- share avoided where a fountain is within reach
        )
    """)
    con.execute(
        "INSERT INTO cost_model VALUES (?, ?, ?)",
        [PET_THRESHOLD_C, SHADE_EFFECT, FOUNTAIN_EFFECT],
    )
    con.execute("""
        CREATE OR REPLACE TABLE layout_warp (
            profile VARCHAR, trees BOOLEAN, fountains BOOLEAN, slope BOOLEAN,
            x0 DOUBLE, y0 DOUBLE,  -- LV95 metres of lattice node (0, 0)
            step_m DOUBLE,
            nx INTEGER, ny INTEGER,
            moved DOUBLE[],        -- warped (x, y) of every lattice node, x-major
            PRIMARY KEY (profile, trees, fountains, slope)
        )
    """)
    con.execute("""
        CREATE OR REPLACE TABLE layout_meta (
            profile VARCHAR,              -- heat-sensitivity profile, see cost_model.py
            trees BOOLEAN,                -- tree shade counted
            fountains BOOLEAN,            -- fountains counted
            slope BOOLEAN,                -- slope counted
            built_at TIMESTAMP,
            cost VARCHAR,                 -- the cost formula
            scale_c DOUBLE,               -- the profile's PET scale
            slope_weight DOUBLE,          -- the profile's slope weight
            reference_median DOUBLE,      -- cost per metre 1 in the layout (median without factors)
            heat_factor_median DOUBLE,    -- this variant's own median cost per metre
            exaggeration DOUBLE,          -- target area = ratio ^ this
            area_ratio_p01 DOUBLE,        -- area change of 250 m blocks with network
            area_ratio_p50 DOUBLE,
            area_ratio_p99 DOUBLE,
            area_ratio_max DOUBLE,
            displacement_median_m DOUBLE, -- how far nodes moved from geography
            displacement_p95_m DOUBLE,
            displacement_max_m DOUBLE,
            PRIMARY KEY (profile, trees, fountains, slope)
        )
    """)

    # Cartogram grid centred on the network; edges add their length at their midpoint
    bounds = np.array([geo.min(axis=0), geo.max(axis=0)])
    origin = bounds.mean(axis=0) - GRID_SIZE * CELL_M / 2
    mid_cell = np.floor(((geo[src] + geo[dst]) / 2 - origin) / CELL_M).astype(int)

    for profile, scale in PROFILES.items():
        # Fixed reference: what a typical metre costs without trees, fountains and slope
        reference = median_heat_factor(
            edge_factor(all_heat, profile, False, False, False), all_edges["length_m"]
        )
        for trees, fountains, slope in VARIANTS:
            started = time.time()
            median = median_heat_factor(
                edge_factor(all_heat, profile, trees, fountains, slope), all_edges["length_m"]
            )
            ratio = edge_factor(heat, profile, trees, fountains, slope) / reference
            density = heat_density(origin, mid_cell, length, ratio, args.exaggeration)
            warp = stored_warp(origin, diffuse(density), bounds)
            areas = block_area_ratios(warp, geo)
            displacement = np.linalg.norm(warp.apply(geo) - geo, axis=1)
            quality = {
                "area_ratio_p01": float(np.percentile(areas, 1)),
                "area_ratio_p50": float(np.percentile(areas, 50)),
                "area_ratio_p99": float(np.percentile(areas, 99)),
                "area_ratio_max": float(areas.max()),
                "displacement_median_m": float(np.median(displacement)),
                "displacement_p95_m": float(np.percentile(displacement, 95)),
                "displacement_max_m": float(displacement.max()),
            }

            nx, ny = warp.moved.shape[:2]
            con.execute(
                "INSERT INTO layout_warp VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                [profile, trees, fountains, slope, warp.x0, warp.y0, warp.step_m, nx, ny,
                 warp.moved.ravel().round(2).tolist()],
            )
            relief = (f" * (1 - {SHADE_EFFECT:g} * shade)" if trees else "") + (
                f" * (1 - {FOUNTAIN_EFFECT:g} * fountain)" if fountains else ""
            )
            weight = SLOPE_WEIGHT[profile]
            slope_term = f" * (1 + {weight:g} * slope_excess)" if slope else ""
            con.execute(
                "INSERT INTO layout_meta VALUES (?, ?, ?, ?, now(), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                [
                    profile,
                    trees,
                    fountains,
                    slope,
                    f"length_m{slope_term} * (1 + max(PET - {PET_THRESHOLD_C:g} C, 0)^2{relief}"
                    f" / {scale:g} C^2)",
                    scale,
                    weight,
                    reference,
                    median,
                    args.exaggeration,
                    *quality.values(),
                ],
            )
            print(
                f"[{profile}, trees {'on' if trees else 'off'}, fountains {'on' if fountains else 'off'}, "
                f"slope {'on' if slope else 'off'}] "
                f"{time.time() - started:.0f}s; 250 m blocks x{quality['area_ratio_p01']:.2f} .. "
                f"x{quality['area_ratio_p99']:.2f} (median x{quality['area_ratio_p50']:.2f}, "
                f"max x{quality['area_ratio_max']:.2f}); nodes moved median "
                f"{quality['displacement_median_m']:.0f} m, max {quality['displacement_max_m']:.0f} m"
            )
    con.close()


if __name__ == "__main__":
    main()
