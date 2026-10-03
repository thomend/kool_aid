// Typed client for the FastAPI backend (api/graph.py).

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
  /** Walking cost in metres: length_m inflated for heat stress, see scripts/build_layout.py. */
  walk_cost_m: number;
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
    start_indices: number[];
    geo: number[];
    cost: number[];
  };
  context: {
    lines: { name: string; geo: number[]; cost: number[] }[];
    labels: { name: string; kind: string; geo: number[]; cost: number[] }[];
  };
}

export const fetchCostSpace = (signal?: AbortSignal) =>
  getJson<CostSpaceData>("/api/layout/cost-space", signal);
