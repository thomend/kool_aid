"""Heat-stress cost model for walking, shared by the pipeline scripts.

An edge's walking cost is its length stretched by heat stress:

    cost_m = length_m * mean over the edge of (1 + (max(PET - 29 C, 0) / scale)^2)
           = length_m * (1 + heat_excess_sq_mean / scale^2)

PET (physiological equivalent temperature, VDI 3787) below 29 C is at most
slight heat stress and costs just the distance. Above it the factor grows
quadratically, so the hottest stretches get disproportionately expensive.
The factor is averaged over the 1 m samples of an edge (not computed from the
mean PET), so a half-shaded, half-sunny edge keeps the cost of its sunny half.

`scale` is the number of degrees above the threshold at which a metre costs
double; each heat-sensitivity profile has its own:

    PET              29 C   33 C   35 C   41 C   44 C
    low    (16 C)    1.0    1.06   1.14   1.56   1.88
    medium (12 C)    1.0    1.11   1.25   2.0    2.56
    high    (8 C)    1.0    1.25   1.56   3.25   4.52
"""

import numpy as np

PET_THRESHOLD_C = 29.0  # VDI 3787: "moderate heat stress" starts here

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


def heat_factor(heat_excess_sq_mean, scale_c):
    """Cost multiplier per metre of an edge, from its mean squared excess."""
    return 1 + np.asarray(heat_excess_sq_mean, dtype=float) / scale_c**2
