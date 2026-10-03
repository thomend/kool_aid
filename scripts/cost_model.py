"""The cost model: which factors make walking an edge more expensive, and how.

    cost(edge) = length_m × max(0.1, Σ_k  weight_k · x_k(edge))

Every factor contributes a multiple of the edge's length: x_k is the
factor's value on the edge after its transform, weight_k how many times the
length one unit of x_k adds. A factor that is switched off has weight 0.
The 0.1 floor keeps costs positive (e.g. distance off and a cool street, or
negative weights such as trees later).

Factors
  distance  x = 1 on every edge: each metre counts weight times.
            Default weight 1, so distance alone gives cost = length.
  heat   PET (physiological equivalent temperature) at 14:00 from the
         Stadtklima raster, either today or the 2030 scenario (one at a time).
         x = degrees above thermal comfort = max(PET − 23 °C, 0)
         (VDI 3787: up to 23 °C is "no thermal stress").
         Default weight 1/18: a 41 °C stretch costs twice its length.
         Edges without a PET value count as comfortable (x = 0).

Factor kinds
  static    values come from data and are read-only in the UI (heat)
  editable  users may change values per edge or globally (trees, planned)
Weights are adjustable for both kinds.

This module is the single definition. build_factors.py writes it to DuckDB,
build_layout.py lays out the graph with the default cost function, the API
serves it, and the web app evaluates the same formula (web/src/cost.ts) so
users can switch cost functions and change weights live.
"""

from dataclasses import dataclass, field

import numpy as np

COST_FLOOR = 0.1


@dataclass(frozen=True)
class Variant:
    key: str     # e.g. "today"
    label: str
    column: str  # column in edge_factors holding the raw values


@dataclass(frozen=True)
class Factor:
    key: str
    label: str
    kind: str                 # "static" | "editable"
    unit: str                 # unit of x after the transform
    description: str
    variants: list[Variant]   # data sources; the user picks one (none for "constant")
    transform: str = "above_threshold"  # "constant": x = 1 | "above_threshold": x = max(value − threshold, 0)
    threshold: float = 0.0
    default_weight: float = 0.0
    weight_max: float = 1.0   # slider range in the UI is 0 … weight_max


@dataclass(frozen=True)
class CostFunction:
    """A named setting for every factor: {factor_key: (weight, variant_key or None)}.

    Factors not listed are switched off.
    """
    id: str
    label: str
    description: str
    factors: dict[str, tuple[float, str | None]] = field(default_factory=dict)


HEAT_WEIGHT = 1 / 18

FACTORS: list[Factor] = [
    Factor(
        key="distance",
        label="Distance",
        kind="static",
        unit="metre",
        description="The street length: every metre walked counts.",
        variants=[],
        transform="constant",
        default_weight=1.0,
        weight_max=2.0,
    ),
    Factor(
        key="heat",
        label="Heat",
        kind="static",
        unit="°C",
        description="Heat stress (PET at 14:00) above 23 °C makes a street more costly to walk.",
        variants=[
            Variant("today", "Today", "pet_c"),
            Variant("2030", "2030", "pet_2030_c"),
        ],
        threshold=23.0,
        default_weight=HEAT_WEIGHT,
        weight_max=0.15,
    ),
]

COST_FUNCTIONS: list[CostFunction] = [
    CostFunction(
        id="distance",
        label="Distance",
        description="Shortest walk: cost is the street length.",
        factors={"distance": (1.0, None)},
    ),
    CostFunction(
        id="heat-today",
        label="Heat today",
        description="Hot streets cost more: a 41 °C stretch counts twice its length.",
        factors={"distance": (1.0, None), "heat": (HEAT_WEIGHT, "today")},
    ),
    CostFunction(
        id="heat-2030",
        label="Heat 2030",
        description="Like Heat today, with the 2030 climate scenario.",
        factors={"distance": (1.0, None), "heat": (HEAT_WEIGHT, "2030")},
    ),
]

DEFAULT_COST_FUNCTION = "heat-today"


def factor_value(columns, factor, variant_key, n):
    """Transformed factor value x per edge; missing raw values (NaN) count as 0."""
    if factor.transform == "constant":
        return np.ones(n)
    variant = next(v for v in factor.variants if v.key == variant_key)
    raw = np.asarray(columns[variant.column], dtype=float)
    return np.where(np.isnan(raw), 0.0, np.maximum(raw - factor.threshold, 0.0))


def evaluate(length_m, columns, settings, factors=FACTORS):
    """Cost per edge.

    length_m  array of edge lengths in metres
    columns   {column name: array of raw values}, aligned with length_m
    settings  {factor_key: (weight, variant_key)}; missing factors are off
    """
    length_m = np.asarray(length_m, dtype=float)
    multiplier = np.zeros_like(length_m)
    for factor in factors:
        weight, variant_key = settings.get(factor.key, (0.0, None))
        if not weight:
            continue
        multiplier += weight * factor_value(columns, factor, variant_key, len(length_m))
    return length_m * np.maximum(multiplier, COST_FLOOR)


def default_settings():
    return next(f for f in COST_FUNCTIONS if f.id == DEFAULT_COST_FUNCTION).factors
