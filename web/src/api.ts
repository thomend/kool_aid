// Typed client for the FastAPI backend (api/graph.py).

import type { HeatProfile } from "./profiles";

export interface Bounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

export interface GraphMeta {
  node_count: number;
  edge_count: number;
  component_count: number;
  total_length_km: number;
  bounds: Bounds;
  length_quantiles_m: Record<"p10" | "p25" | "p50" | "p75" | "p90", number>;
  walk_cost_quantiles_m: Record<"p10" | "p25" | "p50" | "p75" | "p90", number>;
  highway_counts: Record<string, number>;
  node_type_counts: Record<string, number>;
  /** Simulated walks behind the leverage (scripts/build_leverage.py); null if not built. */
  walks: number | null;
}

export type NodeType = "intersection" | "junction" | "dead_end";

export interface EdgeSummary {
  id: number;
  source: number;
  target: number;
  way_osm_id: number;
  street_name: string | null;
  highway: string;
  is_pedestrian: boolean;
  length_m: number;
  component: number;
  /** PET (physiological equivalent temperature) at 14:00, degrees C; null outside raster coverage. */
  pet_mean_c: number | null;
  /** Walking cost in metres per heat profile: length_m inflated for heat stress, see scripts/cost_model.py. */
  walk_cost_m: Record<HeatProfile, number>;
  /** Simulated walks whose shortest route uses the edge; null off the main network. */
  trips_shortest: number | null;
  /** Simulated walks whose coolest route still uses the edge, per heat profile. */
  trips_coolest: Record<HeatProfile, number> | null;
  /** Percentile rank (0–100) of where shade would help most, per heat profile. */
  leverage_pct: Record<HeatProfile, number> | null;
}

/** A street in the ranking of where shade would help walkers most. */
export interface LeverageItem {
  street_name: string | null;
  highway: string;
  /** A named street at the way's ends, for unnamed ways such as sidewalks. */
  near_street: string | null;
  /** Share of the city's total leverage, in percent. */
  share_pct: number;
  length_m: number;
  pet_mean_c: number | null;
  /** The street's edge with the highest leverage. */
  edge_id: number;
  lon: number;
  lat: number;
}

export interface NodeDetail {
  id: number;
  lon: number;
  lat: number;
  degree: number;
  node_type: NodeType;
  component: number;
  street_names: string[];
  edges: EdgeSummary[];
}

export const EDGES_URL = "/api/graph/edges";
export const NODES_URL = "/api/graph/nodes";

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} – ${url}`);
  return res.json() as Promise<T>;
}

export const fetchMeta = (signal?: AbortSignal) => getJson<GraphMeta>("/api/graph/meta", signal);

export const fetchNode = (id: number, signal?: AbortSignal) =>
  getJson<NodeDetail>(`/api/graph/nodes/${id}`, signal);

export const fetchEdge = (id: number, signal?: AbortSignal) =>
  getJson<EdgeSummary>(`/api/graph/edges/${id}`, signal);

export interface LayoutMeta {
  profile: HeatProfile;
  built_at: string;
  cost: string;
  alpha: number;
  iterations: number;
  edge_stretch_median: number;
  edge_stretch_p05: number;
  edge_stretch_p95: number;
  displacement_median_m: number;
  displacement_p95_m: number;
  displacement_max_m: number;
}

// Flat coordinate lists [x0, y0, x1, y1, …] in metres relative to origin_lv95.
export interface CostSpaceData {
  meta: LayoutMeta;
  origin_lv95: [number, number];
  bounds: { min_x: number; min_y: number; max_x: number; max_y: number };
  nodes: {
    ids: number[];
    node_type: NodeType[];
    degree: number[];
    geo: number[];
    cost: number[];
  };
  edges: {
    ids: number[];
    source: number[];
    target: number[];
    street_name: (string | null)[];
    highway: string[];
    is_pedestrian: boolean[];
    length_m: number[];
    pet_mean_c: (number | null)[];
    walk_cost_m: number[];
    /** Percentile rank of the leverage, 0 where shade would not help. */
    leverage_pct: number[];
    /** Loose end of a road cut off where the data ends (mostly the city border); drawn faded. */
    is_stub: boolean[];
    start_indices: number[];
    geo: number[];
    cost: number[];
  };
  context: {
    lines: { name: string; geo: number[]; cost: number[] }[];
    labels: { name: string; kind: string; geo: number[]; cost: number[] }[];
  };
}

export const fetchLeverage = (profile: HeatProfile, signal?: AbortSignal) =>
  getJson<LeverageItem[]>(`/api/graph/leverage?profile=${profile}`, signal);

export const fetchCostSpace = (profile: HeatProfile, signal?: AbortSignal) =>
  getJson<CostSpaceData>(`/api/layout/cost-space?profile=${profile}`, signal);
