// The walking-cost formula of scripts/cost_model.py, evaluated in the browser so
// heat profile and relief (tree shade, fountains) can be switched instantly.
// The constants come from the API (GraphMeta.cost_model); keep the formula in
// sync with cost_model.py and with heatFactorExpression in map/style.ts.

import type { CostModel } from "./api";
import type { HeatProfile } from "./profiles";

/** Which kinds of relief soften the heat cost. */
export interface Relief {
  trees: boolean;
  fountains: boolean;
}

export const FULL_RELIEF: Relief = { trees: true, fountains: true };

export const reliefKey = (r: Relief) => `${r.trees ? "trees" : "-"}|${r.fountains ? "fountains" : "-"}`;

const share = (v: number | null) => Math.min(1, Math.max(0, v ?? 0));

/** Cost multiplier per metre: 1 + heat excess × relief / scale². */
export function heatFactor(
  model: CostModel,
  profile: HeatProfile,
  relief: Relief,
  heatExcessSq: number,
  shadeShare: number | null,
  fountainShare: number | null,
): number {
  const shade = relief.trees ? 1 - model.shade_effect * share(shadeShare) : 1;
  const fountain = relief.fountains ? 1 - model.fountain_effect * share(fountainShare) : 1;
  return 1 + (heatExcessSq * shade * fountain) / model.scale_c[profile] ** 2;
}

/** What a typical metre costs without trees and fountains: the fixed reference. */
export const referenceMedian = (model: CostModel, profile: HeatProfile) =>
  model.reference_median[profile];
