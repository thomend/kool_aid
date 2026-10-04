"""Walking cost model (heat stress and slope), shared by the pipeline scripts.

    cost_m = length_m * slope * (1 + heat_excess_sq_mean * relief / scale^2)
    slope  = 1 + SLOPE_WEIGHT[profile] * slope_excess
    relief = (1 - SHADE_EFFECT * shade_share) * (1 - FOUNTAIN_EFFECT * fountain_share)

heat_excess_sq_mean is the mean of max(PET - 29 C, 0)^2 over an edge's 1 m
samples. Below 29 C PET (VDI 3787: at most slight heat stress) a metre costs
just its length; above, the cost grows quadratically. Averaging per sample
keeps the cost of the sunny half of a half-shaded edge.

`scale` is how many degrees above the threshold double the cost of a metre,
one per heat-sensitivity profile (unshaded):

    PET              29 C   33 C   35 C   41 C   44 C
    low    (16 C)    1.0    1.06   1.14   1.56   1.88
    medium (12 C)    1.0    1.11   1.25   2.0    2.56
    high    (8 C)    1.0    1.25   1.56   3.25   4.52

Relief only lowers the heat part, so missing trees or fountains never add cost.
Tree shade (share of the edge under a crown) halves it at most; the effect is
moderate because the PET raster already reflects some shade. A fountain within
100 m offers a drink and a cool-down but no shade, so it helps less.

slope_excess (join_slope_edges.py) is how much longer a metre takes than on
the flat, uphill and downhill alike (5 %: +19 %, 10 %: +42 %). It multiplies the
whole cost: walking slower also means longer in the heat.
"""

import numpy as np

PET_THRESHOLD_C = 29.0  # VDI 3787: "moderate heat stress" starts here
SHADE_EFFECT = 0.5  # share of the heat excess a fully shaded edge avoids
FOUNTAIN_EFFECT = 0.2  # share of the heat excess avoided where a fountain is within reach

# Heat-sensitivity profile -> PET scale (the frontend gets them from the API)
PROFILES = {
    "low": 16.0,  # fit adults, short trips
    "medium": 12.0,  # default
    "high": 8.0,  # elderly people, small children, people with heart conditions
}

# Slope: Tobler's hiking function made symmetric, exp(TOBLER_STEEPNESS * |grade|),
# is how much longer a metre takes than on the flat; the weight per profile
# scales that extra time (slopes are harder for heat-sensitive people)
TOBLER_STEEPNESS = 3.5
MAX_GRADE = 0.3  # steeper pieces (steps, terrain noise) count as 30 %
SLOPE_WEIGHT = {"low": 0.5, "medium": 1.0, "high": 2.0}


def heat_excess_sq(pet_c):
    """Squared degrees of PET above the threshold, per sample; NaN stays NaN."""
    return np.maximum(np.asarray(pet_c, dtype=float) - PET_THRESHOLD_C, 0.0) ** 2


def relieved_heat_excess_sq(heat_excess_sq_mean, shade_share, fountain_share):
    """Heat excess an edge is exposed to once tree shade and nearby fountains are counted."""
    shade = np.clip(np.asarray(shade_share, dtype=float), 0.0, 1.0)
    fountain = np.clip(np.asarray(fountain_share, dtype=float), 0.0, 1.0)
    relief = (1 - SHADE_EFFECT * shade) * (1 - FOUNTAIN_EFFECT * fountain)
    return np.asarray(heat_excess_sq_mean, dtype=float) * relief


def median_heat_factor(factor, length_m):
    """Length-weighted median heat factor: what a typical metre of the network costs."""
    order = np.argsort(factor)
    cumulative = np.cumsum(np.asarray(length_m, dtype=float)[order])
    return float(np.asarray(factor)[order][np.searchsorted(cumulative, cumulative[-1] / 2)])


def slope_factor(slope_excess, weight):
    """Cost multiplier per metre for the slope, weighted per profile."""
    return 1 + weight * np.asarray(slope_excess, dtype=float)


def heat_factor(heat_excess_sq_mean, scale_c):
    """Cost multiplier per metre of an edge, from its (relieved) mean squared excess."""
    return 1 + np.asarray(heat_excess_sq_mean, dtype=float) / scale_c**2
