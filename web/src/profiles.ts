// Heat-sensitivity profiles of the cost model (scripts/cost_model.py). Their
// PET scales come from the API (GraphMeta.cost_model.scale_c).

export type HeatProfile = "low" | "medium" | "high";

export const PROFILES: { key: HeatProfile; label: string }[] = [
  { key: "low", label: "Low" },
  { key: "medium", label: "Medium" },
  { key: "high", label: "High" },
];

export const DEFAULT_PROFILE: HeatProfile = "medium";
