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
import type { HeatProfile } from "../profiles";

/** What the edge colour shows: walking cost, or where shade would help most. */
export type ColorMode = "cost" | "leverage";

interface EdgeCategory {
  label: string;
  highways: string[];
}

// Labels for unnamed edges. Order matters: the first category whose highways match wins
const EDGE_CATEGORIES: EdgeCategory[] = [
  {
    label: "Steps",
    highways: ["steps"],
  },
  {
    label: "Pedestrian zone",
    highways: ["pedestrian", "living_street"],
  },
  {
    label: "Footpath",
    highways: ["footway", "path", "track", "cycleway"],
  },
  {
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

// Cool → hot by heat factor (cost per metre): blue where a metre costs a metre,
// pink where heat makes it count double or more. Fixed stops, the same for every
// profile, so switching heat sensitivity visibly changes the colours.
const COST_RAMP: Record<Scheme, string[]> = {
  light: ["#5ac8fa", "#007aff", "#5856d6", "#af52de", "#ff2d55"],
  dark: ["#64d2ff", "#0a84ff", "#5e5ce6", "#bf5af2", "#ff375f"],
};
const HEAT_FACTOR_STOPS = [1, 1.1, 1.5, 2, 3];

export function costStops(scheme: Scheme): [number, string][] {
  return HEAT_FACTOR_STOPS.map((v, i) => [v, COST_RAMP[scheme][i]]);
}

// Grey → red: edges where shade would help little fade out, the top few percent glow red.
// Stops are percentile ranks of the leverage (scripts/build_leverage.py).
const LEVERAGE_RAMP: Record<Scheme, string[]> = {
  light: ["#d1d1d6", "#dcc7ad", "#ff7a00", "#ff3b30", "#a8002a"],
  dark: ["#48484a", "#6b5a45", "#ff9f0a", "#ff453a", "#ff2d55"],
};
const LEVERAGE_PCT = [0, 70, 90, 97, 99.5];

export function leverageStops(scheme: Scheme): [number, string][] {
  return LEVERAGE_PCT.map((v, i) => [v, LEVERAGE_RAMP[scheme][i]]);
}

export const ACCENT: Record<Scheme, string> = { light: "#007aff", dark: "#0a84ff" };
const SURFACE: Record<Scheme, string> = { light: "#ffffff", dark: "#2c2c2e" };
const NODE_STROKE: Record<Scheme, string> = { light: "#3a3a3c", dark: "#d1d1d6" };

function edgeColor(
  scheme: Scheme,
  profile: HeatProfile,
  mode: ColorMode,
): ExpressionSpecification {
  if (mode === "leverage") {
    return [
      "interpolate",
      ["linear"],
      ["coalesce", ["get", `leverage_pct_${profile}`], 0],
      ...leverageStops(scheme).flat(),
    ] as ExpressionSpecification;
  }
  return [
    "interpolate",
    ["linear"],
    // heat factor: walking cost per metre of length
    ["/", ["get", `walk_cost_m_${profile}`], ["max", ["get", "length_m"], 0.1]],
    ...costStops(scheme).flat(),
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

function graphLayers(
  scheme: Scheme,
  profile: HeatProfile,
  mode: ColorMode,
): LayerSpecification[] {
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
        "line-color": ["case", selected, ACCENT[scheme], edgeColor(scheme, profile, mode)],
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

export function buildStyle(
  scheme: Scheme,
  profile: HeatProfile,
  mode: ColorMode,
): StyleSpecification {
  const { below, above } = basemapLayers(scheme);
  const [glow, edges, nodes] = graphLayers(scheme, profile, mode);
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
