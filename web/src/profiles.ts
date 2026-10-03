// Heat-sensitivity profiles of the cost model. Keep in sync with
// scripts/cost_model.py (PROFILES): cost = length × (1 + (max(PET − 29 °C, 0) / scale)²).

export type HeatProfile = "low" | "medium" | "high";

export const PET_THRESHOLD_C = 29;

export const PROFILES: { key: HeatProfile; label: string; scaleC: number }[] = [
  { key: "low", label: "Low", scaleC: 16 },
  { key: "medium", label: "Medium", scaleC: 12 },
  { key: "high", label: "High", scaleC: 8 },
];

export const DEFAULT_PROFILE: HeatProfile = "medium";

/** Cost multiplier per metre at a given PET. */
export function heatFactor(profile: HeatProfile, petC: number): number {
  const scale = PROFILES.find((p) => p.key === profile)!.scaleC;
  return 1 + (Math.max(petC - PET_THRESHOLD_C, 0) / scale) ** 2;
}
