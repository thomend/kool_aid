// The walking-cost formula of scripts/cost_model.py, evaluated in the browser so
// heat profile and factors (tree shade, fountains, slope) switch instantly.
// Constants come from the API (GraphMeta.cost_model); the formula also lives in
// costFactorExpression (map/style.ts) and api/routing.py.

import type { CostModel } from "./api";
import type { HeatProfile } from "./profiles";

/** Which factors count: tree shade and fountains soften the heat, slope adds effort. */
export interface Factors {
  trees: boolean;
  fountains: boolean;
  slope: boolean;
}

export const ALL_FACTORS: Factors = { trees: true, fountains: true, slope: true };
export const NO_FACTORS: Factors = { trees: false, fountains: false, slope: false };

export const factorsKey = (f: Factors) =>
  [f.trees && "trees", f.fountains && "fountains", f.slope && "slope"].filter(Boolean).join("+") || "-";

const share = (v: number | null) => Math.min(1, Math.max(0, v ?? 0));

/** Cost per metre: slope × (1 + heat excess × relief / scale²). */
export function costFactor(
  model: CostModel,
  profile: HeatProfile,
  factors: Factors,
  heatExcessSq: number,
  shadeShare: number | null,
  fountainShare: number | null,
  slopeExcess: number | null,
): number {
  const shade = factors.trees ? 1 - model.shade_effect * share(shadeShare) : 1;
  const fountain = factors.fountains ? 1 - model.fountain_effect * share(fountainShare) : 1;
  const slope = factors.slope ? 1 + model.slope_weight[profile] * (slopeExcess ?? 0) : 1;
  return slope * (1 + (heatExcessSq * shade * fountain) / model.scale_c[profile] ** 2);
}

/** What a typical metre costs without trees, fountains and slope: the fixed reference. */
export const referenceMedian = (model: CostModel, profile: HeatProfile) =>
  model.reference_median[profile];
