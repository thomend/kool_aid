"""Heat-stress cost model for walking, shared by the pipeline scripts.

An edge's walking cost is its length stretched by heat stress, softened by tree shade
and nearby fountains:

    cost_m = length_m * (1 + heat_excess_sq_mean * relief / scale^2)
    relief = (1 - SHADE_EFFECT * shade_share) * (1 - FOUNTAIN_EFFECT * fountain_share)

heat_excess_sq_mean is the mean over the edge of max(PET - 29 C, 0)^2, so without shade
this is the mean of (1 + (max(PET - 29 C, 0) / scale)^2) along the edge.

PET (physiological equivalent temperature, VDI 3787) below 29 C is at most
slight heat stress and costs just the distance. Above it the factor grows
quadratically, so the hottest stretches get disproportionately expensive.
The factor is averaged over the 1 m samples of an edge (not computed from the
mean PET), so a half-shaded, half-sunny edge keeps the cost of its sunny half.

`scale` is the number of degrees above the threshold at which a metre costs
double; each heat-sensitivity profile has its own (unshaded):

    PET              29 C   33 C   35 C   41 C   44 C
    low    (16 C)    1.0    1.06   1.14   1.56   1.88
    medium (12 C)    1.0    1.11   1.25   2.0    2.56
    high    (8 C)    1.0    1.25   1.56   3.25   4.52

Tree shade (shade_share: share of the edge under a tree crown, from
join_trees_edges.py) only lowers the heat part: trees don't make a cool street
cheaper, and a fully shaded edge keeps 1 - SHADE_EFFECT of its extra heat cost
(medium, 41 C: 2.0 -> 1.5). The PET raster already reflects some of that shade
(shaded streets are ~0.5 C cooler in it), so the effect stays moderate. The
cadastre has public trees only, so missing trees never add cost.

Fountains (fountain_share: share of the edge within 100 m of one, from
join_fountains_edges.py) are a place to drink and cool down on the way. They
don't shade the walk itself, so they help less than trees: an edge entirely
within reach of a fountain keeps 1 - FOUNTAIN_EFFECT of its extra heat cost
(medium, 41 C, no shade: 2.0 -> 1.8; with full shade too: 1.5 -> 1.4).
"""

import numpy as np

PET_THRESHOLD_C = 29.0  # VDI 3787: "moderate heat stress" starts here
SHADE_EFFECT = 0.5  # share of the heat excess a fully shaded edge avoids
FOUNTAIN_EFFECT = 0.2  # share of the heat excess avoided where a fountain is within reach

# Heat-sensitivity profile -> PET_SCALE_C. Keep in sync with web/src/profiles.ts.
PROFILES = {
    "low": 16.0,  # fit adults, short trips
    "medium": 12.0,  # default
    "high": 8.0,  # elderly people, small children, people with heart conditions
}
DEFAULT_PROFILE = "medium"


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


def heat_factor(heat_excess_sq_mean, scale_c):
    """Cost multiplier per metre of an edge, from its (relieved) mean squared excess."""
    return 1 + np.asarray(heat_excess_sq_mean, dtype=float) / scale_c**2
