// Builds the complete MapLibre style: basemap + walkable graph on top.
// The whole style is rebuilt whenever an input changes; MapLibre diffs it
// against the current one, so only changed paint properties are applied.

import type {
  ExpressionSpecification,
  LayerSpecification,
  StyleSpecification,
} from "@maplibre/maplibre-gl-style-spec";
import { EDGES_URL, NODES_URL, type GraphMeta } from "../api";
import { BASEMAP_SOURCE, GLYPHS, basemapLayers, type Scheme } from "./basemap";
import type { HeatProfile } from "../profiles";

export interface EdgeCategory {
  key: string;
  label: string;
  highways: string[];
}

// Labels for unnamed edges. Order matters: the first category whose highways match wins
export const EDGE_CATEGORIES: EdgeCategory[] = [
  {
    key: "steps",
    label: "Steps",
    highways: ["steps"],
  },
  {
    key: "zone",
    label: "Pedestrian zone",
    highways: ["pedestrian", "living_street"],
  },
  {
    key: "footpath",
    label: "Footpath",
    highways: ["footway", "path", "track", "cycleway"],
  },
  {
    key: "street",
    label: "Street",
    highways: [],
  },
];

export function categoryOf(highway: string): EdgeCategory {
  return (
    EDGE_CATEGORIES.find((c) => c.highways.includes(highway)) ??
    EDGE_CATEGORIES[EDGE_CATEGORIES.length - 1]
  );
}

// Cool → hot: short (cheap) edges are blue, long (expensive) ones pink
const COST_RAMP: Record<Scheme, string[]> = {
  light: ["#5ac8fa", "#007aff", "#5856d6", "#af52de", "#ff2d55"],
  dark: ["#64d2ff", "#0a84ff", "#5e5ce6", "#bf5af2", "#ff375f"],
};

export function costStops(meta: GraphMeta, scheme: Scheme): [number, string][] {
  const q = meta.walk_cost_quantiles_m;
  const values = [q.p10, q.p50, q.p75, q.p90, q.p90 * 2.5];
  // interpolate needs strictly ascending stops
  for (let i = 1; i < values.length; i++) values[i] = Math.max(values[i], values[i - 1] + 0.1);
  return values.map((v, i) => [v, COST_RAMP[scheme][i]]);
}

export const ACCENT: Record<Scheme, string> = { light: "#007aff", dark: "#0a84ff" };
const SURFACE: Record<Scheme, string> = { light: "#ffffff", dark: "#2c2c2e" };
const NODE_STROKE: Record<Scheme, string> = { light: "#3a3a3c", dark: "#d1d1d6" };

function edgeColor(meta: GraphMeta, scheme: Scheme, profile: HeatProfile): ExpressionSpecification {
  return [
    "interpolate",
    ["linear"],
    ["get", `walk_cost_m_${profile}`],
    ...costStops(meta, scheme).flat(),
  ] as ExpressionSpecification;
}

const isPedestrian: ExpressionSpecification = ["==", ["get", "is_pedestrian"], true];
const isMainComponent: ExpressionSpecification = ["==", ["get", "component"], 0];
const hovered: ExpressionSpecification = ["boolean", ["feature-state", "hover"], false];
const selected: ExpressionSpecification = ["boolean", ["feature-state", "selected"], false];

// Width grows with zoom; `scale` may depend on feature-state (it is applied
// inside each zoom stop because zoom must stay the top-level expression)
function edgeWidth(scale: number | ExpressionSpecification, extra = 0): ExpressionSpecification {
  const at = (ped: number, street: number) =>
    ["+", ["*", ["case", isPedestrian, ped, street], scale], extra] as ExpressionSpecification;
  return [
    "interpolate",
    ["exponential", 1.5],
    ["zoom"],
    11, at(0.6, 0.45),
    13, at(1.1, 0.8),
    15, at(2.2, 1.6),
    17, at(4, 3),
    19, at(8, 6),
  ];
}

function graphLayers(meta: GraphMeta, scheme: Scheme, profile: HeatProfile): LayerSpecification[] {
  return [
    {
      id: "edges-glow",
      type: "line",
      source: "graph-edges",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": ACCENT[scheme],
        "line-width": edgeWidth(1, 8),
        "line-blur": 3,
        "line-opacity": ["case", selected, 0.45, hovered, 0.3, 0],
      },
    },
    {
      id: "edges",
      type: "line",
      source: "graph-edges",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": ["case", selected, ACCENT[scheme], edgeColor(meta, scheme, profile)],
        "line-width": edgeWidth(["case", ["any", selected, hovered], 1.6, 1]),
        "line-opacity": ["case", isMainComponent, 0.95, 0.35],
      },
    },
    {
      id: "nodes",
      type: "circle",
      source: "graph-nodes",
      minzoom: 14.5,
      filter: ["!=", ["get", "node_type"], "junction"],
      paint: {
        "circle-radius": [
          "interpolate",
          ["linear"],
          ["zoom"],
          14.5, ["case", selected, 5, ["==", ["get", "node_type"], "intersection"], 1.6, 1.3],
          18, ["case", selected, 9, ["==", ["get", "node_type"], "intersection"], 4.5, 3.5],
        ],
        "circle-color": [
          "case",
          selected, ACCENT[scheme],
          ["==", ["get", "node_type"], "dead_end"], NODE_STROKE[scheme],
          SURFACE[scheme],
        ],
        "circle-stroke-color": ["case", selected, SURFACE[scheme], NODE_STROKE[scheme]],
        "circle-stroke-width": [
          "interpolate", ["linear"], ["zoom"],
          14.5, ["case", selected, 2, 0.6],
          18, ["case", selected, 3, 1.5],
        ],
        "circle-opacity": ["interpolate", ["linear"], ["zoom"], 14.5, 0, 15.2, 1],
        "circle-stroke-opacity": ["interpolate", ["linear"], ["zoom"], 14.5, 0, 15.2, 1],
      },
    },
  ];
}

export function buildStyle(scheme: Scheme, meta: GraphMeta, profile: HeatProfile): StyleSpecification {
  const { below, above } = basemapLayers(scheme);
  const [glow, edges, nodes] = graphLayers(meta, scheme, profile);
  return {
    version: 8,
    glyphs: GLYPHS,
    sources: {
      ...BASEMAP_SOURCE,
      "graph-edges": { type: "geojson", data: EDGES_URL, promoteId: "id" },
      "graph-nodes": { type: "geojson", data: NODES_URL, promoteId: "id" },
    },
    layers: [...below, glow, edges, ...above, nodes],
  };
}
