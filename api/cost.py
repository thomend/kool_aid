"""Cost model API: factors, predefined cost functions, raw factor values per edge.

The web app evaluates costs itself (web/src/cost.ts), so users can switch
cost functions, toggle factors and change weights without a round trip:

    cost(edge) = length_m × max(0.1, Σ_k  weight_k · x_k(edge))
    x_k        = 1 for "constant" factors (distance),
                 max(value_k − threshold_k, 0) otherwise; missing values count as 0

Definitions live in scripts/cost_model.py and are written to DuckDB by
scripts/build_factors.py.
"""

import json

import duckdb
import numpy as np
from fastapi import APIRouter, HTTPException, Response
from pydantic import BaseModel

from .graph import DB_PATH

router = APIRouter(prefix="/api/cost", tags=["cost"])

FORMULA = "cost = length_m × max(floor, Σ weight_k · x_k); x = 1 (constant) or max(value − threshold, 0)"
COST_FLOOR = 0.1


class Variant(BaseModel):
    key: str
    label: str
    column: str  # key in /edge-factors `values`


class Factor(BaseModel):
    key: str
    label: str
    kind: str  # "static" (values read-only) | "editable" (users may change values)
    unit: str
    description: str
    variants: list[Variant]  # empty for constant factors
    transform: str  # "constant" (x = 1) | "above_threshold" (x = max(value − threshold, 0))
    threshold: float
    default_weight: float
    weight_max: float


class FactorSetting(BaseModel):
    weight: float
    variant: str | None


class CostFunction(BaseModel):
    id: str
    label: str
    description: str
    factors: dict[str, FactorSetting]  # factors not listed are switched off
    is_default: bool


class CostModel(BaseModel):
    formula: str
    floor: float
    factors: list[Factor]
    functions: list[CostFunction]
    default_function: str


class _Store:
    model: CostModel | None = None
    edge_factors: bytes | None = None
    error: str | None = None

    def load(self):
        try:
            con = duckdb.connect(str(DB_PATH), read_only=True)
            try:
                self.model, self.edge_factors = _build(con)
            finally:
                con.close()
            self.error = None
        except duckdb.CatalogException as e:
            self.model = self.edge_factors = None
            self.error = f"Cost model tables missing, run scripts/build_factors.py ({e})"


def _build(con):
    factors = [
        Factor(
            key=key, label=label, kind=kind, unit=unit, description=description,
            variants=json.loads(variants), transform=transform, threshold=threshold,
            default_weight=default_weight, weight_max=weight_max,
        )
        for key, label, kind, unit, description, variants, transform, threshold, default_weight, weight_max
        in con.sql("""
            SELECT key, label, kind, unit, description, variants,
                   transform, threshold, default_weight, weight_max
            FROM factors ORDER BY position
        """).fetchall()
    ]
    functions = [
        CostFunction(id=i, label=l, description=d, factors=json.loads(f), is_default=dflt)
        for i, l, d, f, dflt in con.sql("""
            SELECT id, label, description, factors, is_default
            FROM cost_functions ORDER BY position
        """).fetchall()
    ]
    model = CostModel(
        formula=FORMULA,
        floor=COST_FLOOR,
        factors=factors,
        functions=functions,
        default_function=next(f.id for f in functions if f.is_default),
    )

    columns = ["length_m", *(v.column for f in factors for v in f.variants)]
    data = con.sql(
        "SELECT edge_id, " + ", ".join(f'"{c}"' for c in columns)
        + " FROM edge_factors ORDER BY edge_id"
    ).fetchnumpy()
    payload = {
        "edge_ids": data["edge_id"].tolist(),
        "values": {c: _nullable(data[c]) for c in columns},
    }
    return model, json.dumps(payload, separators=(",", ":")).encode()


def _nullable(column):
    """Round to 0.01, NULL/NaN as None."""
    values = np.ma.filled(column.astype(float), np.nan).round(2)
    return [None if np.isnan(v) else float(v) for v in values]


store = _Store()


def _require():
    if store.model is None:
        raise HTTPException(503, store.error or "Cost model not loaded")


@router.get("/model", response_model=CostModel)
def get_model():
    """Formula, factor registry and predefined cost functions."""
    _require()
    return store.model


@router.get("/edge-factors", response_description="Columnar raw factor values per edge")
def get_edge_factors():
    """Raw values per edge: {edge_ids: [...], values: {length_m: [...], pet_c: [...], ...}}.

    Arrays are aligned with `edge_ids` (ascending). Missing values are null.
    """
    _require()
    return Response(store.edge_factors, media_type="application/json")
