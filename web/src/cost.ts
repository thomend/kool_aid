// Client-side cost evaluation, mirroring scripts/cost_model.py:
//
//   cost(edge) = length_m × max(floor, Σ_k weight_k · x_k(edge))
//   x_k        = 1 for constant factors (distance),
//                max(value_k − threshold_k, 0) otherwise; missing values count as 0
//
// Each factor can be switched on/off (off = weight 0), weighted, and — if it
// has several data variants (heat today / 2030) — pointed at one of them.
// Evaluating here keeps every change instant, without a server round trip.

import type { CostModel, EdgeFactors, Factor } from "./api";

export interface FactorSetting {
  enabled: boolean;
  weight: number;
  variant: string | null; // null for factors without data variants
}

export type CostSettings = Record<string, FactorSetting>;

export interface BreakdownPart {
  factor: Factor;
  variantLabel: string | null;
  value: number | null; // raw value, e.g. PET in °C; null for constant factors or missing data
  x: number; // after the transform, e.g. °C above comfort
  weight: number;
  metres: number; // length · weight · x, this factor's contribution to the cost
}

export interface Breakdown {
  length: number;
  parts: BreakdownPart[];
  multiplier: number;
  cost: number;
}

export interface EdgeCosts {
  values: Float64Array; // cost in metres, aligned with ids
  /** Cost per metre (cost / length): ×1 = plain length. Used for colouring. */
  perMetre: Float64Array;
  ids: number[];
  /** True when only distance counts, at weight 1: cost = length. */
  isLength: boolean;
  get(edgeId: number): number | undefined;
  perMetreOf(edgeId: number): number | undefined;
  breakdown(edgeId: number): Breakdown | undefined;
}

export function settingsFromFunction(model: CostModel, functionId: string): CostSettings {
  const fn = model.functions.find((f) => f.id === functionId);
  const settings: CostSettings = {};
  for (const factor of model.factors) {
    const s = fn?.factors[factor.key];
    settings[factor.key] = {
      enabled: !!s && s.weight !== 0,
      weight: s?.weight ?? factor.default_weight,
      variant: s?.variant ?? factor.variants[0]?.key ?? null,
    };
  }
  return settings;
}

/** The predefined function these settings correspond to, if any. */
export function matchingFunction(model: CostModel, settings: CostSettings): string | null {
  const same = (a: number, b: number) => Math.abs(a - b) < 1e-6;
  const fn = model.functions.find((f) =>
    model.factors.every((factor) => {
      const s = settings[factor.key];
      const p = f.factors[factor.key];
      if (!s?.enabled || s.weight === 0) return !p || p.weight === 0;
      return !!p && same(p.weight, s.weight) && p.variant === s.variant;
    }),
  );
  return fn?.id ?? null;
}

export function evaluateCosts(model: CostModel, data: EdgeFactors, settings: CostSettings): EdgeCosts {
  const length = data.values.length_m as number[];
  const n = length.length;
  const multiplier = new Float64Array(n);
  const active = model.factors
    .map((factor) => ({ factor, s: settings[factor.key] }))
    .filter(({ s }) => s?.enabled && s.weight !== 0)
    .map(({ factor, s }) => {
      const variant = factor.variants.find((v) => v.key === s.variant) ?? factor.variants[0] ?? null;
      return { factor, weight: s.weight, variant, raw: variant ? data.values[variant.column] : null };
    });
  const xOf = (factor: Factor, raw: (number | null)[] | null, i: number) => {
    if (factor.transform === "constant" || !raw) return 1;
    const v = raw[i];
    return v === null ? 0 : Math.max(v - factor.threshold, 0);
  };

  for (const { factor, weight, raw } of active) {
    for (let i = 0; i < n; i++) multiplier[i] += weight * xOf(factor, raw, i);
  }
  const values = new Float64Array(n);
  const perMetre = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    perMetre[i] = Math.max(multiplier[i], model.floor);
    values[i] = length[i] * perMetre[i];
  }

  const index = new Map<number, number>();
  data.edge_ids.forEach((id, i) => index.set(id, i));
  return {
    values,
    perMetre,
    ids: data.edge_ids,
    isLength: active.length === 1 && active[0].factor.transform === "constant" && active[0].weight === 1,
    get: (id) => {
      const i = index.get(id);
      return i === undefined ? undefined : values[i];
    },
    perMetreOf: (id) => {
      const i = index.get(id);
      return i === undefined ? undefined : perMetre[i];
    },
    breakdown: (id) => {
      const i = index.get(id);
      if (i === undefined) return undefined;
      const parts = active.map(({ factor, weight, variant, raw }) => {
        const x = xOf(factor, raw, i);
        return {
          factor,
          variantLabel: variant?.label ?? null,
          value: raw ? raw[i] : null,
          x,
          weight,
          metres: length[i] * weight * x,
        };
      });
      return { length: length[i], parts, multiplier: perMetre[i], cost: values[i] };
    },
  };
}
