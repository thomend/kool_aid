// Typed client for the FastAPI backend (api/graph.py).

import type { Relief } from "./costModel";
import type { HeatProfile } from "./profiles";

interface Bounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

/** Constants of the walking-cost formula, see costModel.ts and scripts/cost_model.py. */
export interface CostModel {
  pet_threshold_c: number;
  shade_effect: number;
  fountain_effect: number;
  scale_c: Record<HeatProfile, number>;
  /** Median heat factor without trees and fountains: the fixed reference for colours and layout. */
  reference_median: Record<HeatProfile, number>;
}

export interface GraphMeta {
  node_count: number;
  edge_count: number;
  component_count: number;
  total_length_km: number;
  bounds: Bounds;
  /** Constants of the cost formula; null until scripts/build_layout.py has run. */
  cost_model: CostModel | null;
}

type NodeType = "intersection" | "junction" | "dead_end";

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
  /** Cost ingredient: mean squared PET excess over the threshold; null outside the main network. */
  heat_excess_sq_mean: number | null;
  /** Public trees within 15 m; null without tree data. */
  tree_count: number | null;
  /** 0..1, share of the length under a tree crown; softens the heat cost. */
  shade_share: number | null;
  /** Nearest public fountain (straight line); null without fountain data. */
  nearest_fountain: string | null;
  nearest_fountain_m: number | null;
  /** 0..1, share of the length within 100 m of a fountain; softens the heat cost. */
  fountain_share: number | null;
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
  trees: boolean;
  fountains: boolean;
  built_at: string;
  cost: string;
  scale_c: number;
  /** Edges are laid out at cost / this: the median without trees and fountains. */
  reference_median: number;
  /** This variant's own median heat factor. */
  heat_factor_median: number;
  /** Target area = (heat ratio) ^ exaggeration. */
  exaggeration: number;
  /** Area change of 250 m blocks with network (1 = as on the map). */
  area_ratio_p01: number;
  area_ratio_p50: number;
  area_ratio_p99: number;
  area_ratio_max: number;
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
    heat_excess_sq_mean: number[];
    shade_share: number[];
    fountain_share: number[];
    start_indices: number[];
    geo: number[];
    cost: number[];
  };
  context: {
    lines: { name: string; geo: number[]; cost: number[] }[];
    labels: { name: string; kind: string; geo: number[]; cost: number[] }[];
    /** Regular 250 m grid, warped along with the network. */
    grid: { geo: number[]; cost: number[] }[];
    /** The cells between the grid lines near the network; area_ratio > 1: feels bigger. */
    cells: { geo: number[]; cost: number[]; area_ratio: number }[];
  };
}

export const fetchCostSpace = (profile: HeatProfile, relief: Relief, signal?: AbortSignal) =>
  getJson<CostSpaceData>(
    `/api/layout/cost-space?profile=${profile}&trees=${relief.trees}&fountains=${relief.fountains}`,
    signal,
  );

// ---------- route comparison (api/routing.py) ----------

export interface Route {
  edges: number[];
  /** [lon, lat] from start to end */
  coordinates: [number, number][];
  length_m: number;
  /** Walking cost with heat for the profile and relief asked for */
  cost_m: number;
  minutes: number;
  shade_share: number;
}

interface RoutePoint {
  node: number;
  lon: number;
  lat: number;
}

export interface RouteComparison {
  start: RoutePoint;
  end: RoutePoint;
  shortest: Route;
  coolest: Route;
}

export async function fetchRoute(
  start: [number, number],
  end: [number, number],
  profile: HeatProfile,
  relief: Relief,
  signal?: AbortSignal,
): Promise<RouteComparison> {
  const url =
    `/api/route?start=${start.join(",")}&end=${end.join(",")}` +
    `&profile=${profile}&trees=${relief.trees}&fountains=${relief.fountains}`;
  const res = await fetch(url, { signal });
  if (!res.ok) {
    // the API explains what's wrong (too far from the network, same point, ...)
    const detail = await res.json().then((b) => b.detail).catch(() => null);
    throw new Error(typeof detail === "string" ? detail : `${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<RouteComparison>;
}
