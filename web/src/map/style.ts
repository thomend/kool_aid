// Builds the complete MapLibre style: basemap + walkable graph on top.
// The whole style is rebuilt whenever an input changes; MapLibre diffs it
// against the current one, so only changed paint properties are applied.

import type {
  ExpressionSpecification,
  LayerSpecification,
  StyleSpecification,
} from "@maplibre/maplibre-gl-style-spec";
import { EDGES_URL, NODES_URL } from "../api";
import { BASEMAP_SOURCE, GLYPHS, basemapLayers, type Scheme } from "./basemap";

// cost: total cost of the edge · perMetre: how much each metre counts · type: path type
export type ColorMode = "cost" | "perMetre" | "type";

export interface EdgeCategory {
  key: string;
  label: string;
  highways: string[];
  color: Record<Scheme, string>;
}

// Order matters: the first category whose highways match wins
export const EDGE_CATEGORIES: EdgeCategory[] = [
  {
    key: "steps",
    label: "Steps",
    highways: ["steps"],
    color: { light: "#ff2d55", dark: "#ff375f" },
  },
  {
    key: "zone",
    label: "Pedestrian zone",
    highways: ["pedestrian", "living_street"],
    color: { light: "#ff9500", dark: "#ff9f0a" },
  },
  {
    key: "footpath",
    label: "Footpath",
    highways: ["footway", "path", "track", "cycleway"],
    color: { light: "#007aff", dark: "#0a84ff" },
  },
  {
    key: "street",
    label: "Street",
    highways: [],
    color: { light: "#a1a1a8", dark: "#6c6c72" },
  },
];

export function categoryOf(highway: string): EdgeCategory {
  return (
    EDGE_CATEGORIES.find((c) => c.highways.includes(highway)) ??
    EDGE_CATEGORIES[EDGE_CATEGORIES.length - 1]
  );
}

// Both cost scales are fixed (not stretched to the current costs), so every
// change of the cost settings shows: higher costs look hotter.
// Total edge cost in metres: short/cheap (cool blue) … 250 m and more (hot pink).
export const COST_STOPS_M = [5, 20, 50, 100, 250];
// Cost per metre: ×1 (plain length) … ×2.25 and more.
export const COST_PER_M_STOPS = [1, 1.5, 1.75, 2, 2.25];
const COST_RAMP: Record<Scheme, string[]> = {
  light: ["#5ac8fa", "#007aff", "#5856d6", "#af52de", "#ff2d55"],
  dark: ["#64d2ff", "#0a84ff", "#5e5ce6", "#bf5af2", "#ff375f"],
};

export function costStops(mode: "cost" | "perMetre", scheme: Scheme): [number, string][] {
  const stops = mode === "cost" ? COST_STOPS_M : COST_PER_M_STOPS;
  return stops.map((v, i) => [v, COST_RAMP[scheme][i]]);
}

export const ACCENT: Record<Scheme, string> = { light: "#007aff", dark: "#0a84ff" };
const SURFACE: Record<Scheme, string> = { light: "#ffffff", dark: "#2c2c2e" };
const NODE_STROKE: Record<Scheme, string> = { light: "#3a3a3c", dark: "#d1d1d6" };

// Costs are evaluated in the browser (cost.ts) and pushed to the map as
// feature-state "cost" and "perM"; until then fall back to the precomputed
// default cost.
const edgeCost: ExpressionSpecification = ["coalesce", ["feature-state", "cost"], ["get", "walk_cost_m"]];
const edgeCostPerMetre: ExpressionSpecification = [
  "coalesce",
  ["feature-state", "perM"],
  ["/", ["get", "walk_cost_m"], ["max", ["get", "length_m"], 0.01]],
];

function edgeColor(mode: ColorMode, scheme: Scheme): ExpressionSpecification {
  if (mode !== "type") {
    return [
      "interpolate",
      ["linear"],
      mode === "cost" ? edgeCost : edgeCostPerMetre,
      ...costStops(mode, scheme).flat(),
    ] as ExpressionSpecification;
  }
  const match: unknown[] = ["match", ["get", "highway"]];
  for (const c of EDGE_CATEGORIES) {
    if (c.highways.length) match.push(c.highways, c.color[scheme]);
  }
  match.push(EDGE_CATEGORIES[EDGE_CATEGORIES.length - 1].color[scheme]);
  return match as ExpressionSpecification;
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

function graphLayers(mode: ColorMode, scheme: Scheme): LayerSpecification[] {
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
        "line-color": ["case", selected, ACCENT[scheme], edgeColor(mode, scheme)],
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

export function buildStyle(scheme: Scheme, mode: ColorMode): StyleSpecification {
  const { below, above } = basemapLayers(scheme);
  const [glow, edges, nodes] = graphLayers(mode, scheme);
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
