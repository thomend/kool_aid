// Builds the complete MapLibre style: basemap + walkable graph on top.
// The whole style is rebuilt whenever an input changes; MapLibre diffs it
// against the current one, so only changed paint properties are applied.

import type {
  ExpressionSpecification,
  LayerSpecification,
  StyleSpecification,
} from "@maplibre/maplibre-gl-style-spec";
import { EDGES_URL, NODES_URL, type CostModel } from "../api";
import { referenceMedian, type Relief } from "../costModel";
import { BASEMAP_SOURCE, GLYPHS, basemapLayers, type Scheme } from "./basemap";
import type { HeatProfile } from "../profiles";

export interface EdgeCategory {
  key: string;
  label: string;
  highways: string[];
}

// Order matters: the first category whose highways match wins
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

// Diverging heat scale: heat cost per metre relative to a fixed reference, the
// city median without trees and fountains (length-weighted, per profile), so
// switching the relief on visibly cools streets down. Cool teal → neutral grey → hot red; teal,
// not blue, so it never reads as the blue selection accent.
export const HEAT_RATIOS = [0.6, 0.8, 1, 1.25, 1.6];
const HEAT_RAMP: Record<Scheme, string[]> = {
  light: ["#0b8a92", "#62bcc4", "#c4c4c9", "#f39a5b", "#e0352b"],
  dark: ["#40c8e0", "#2c8c99", "#636366", "#d9733f", "#ff453a"],
};
export const NO_DATA: Record<Scheme, string> = { light: "#d1d1d6", dark: "#48484a" };

/** [heat factor, colour] stops for a profile, centred on its fixed reference. */
export function heatStops(model: CostModel, scheme: Scheme, profile: HeatProfile): [number, string][] {
  const reference = referenceMedian(model, profile);
  return HEAT_RATIOS.map((r, i) => [r * reference, HEAT_RAMP[scheme][i]]);
}

/** costModel.heatFactor as a MapLibre expression over an edge's properties. */
function heatFactorExpression(model: CostModel, profile: HeatProfile, relief: Relief): ExpressionSpecification {
  const relieved = (on: boolean, effect: number, key: string): ExpressionSpecification | number =>
    on ? ["-", 1, ["*", effect, ["coalesce", ["get", key], 0]]] : 1;
  return [
    "+",
    1,
    [
      "/",
      [
        "*",
        ["get", "heat_excess_sq_mean"],
        relieved(relief.trees, model.shade_effect, "shade_share"),
        relieved(relief.fountains, model.fountain_effect, "fountain_share"),
      ],
      model.scale_c[profile] ** 2,
    ],
  ];
}

export const ACCENT: Record<Scheme, string> = { light: "#007aff", dark: "#0a84ff" };
const SURFACE: Record<Scheme, string> = { light: "#ffffff", dark: "#2c2c2e" };
const NODE_STROKE: Record<Scheme, string> = { light: "#3a3a3c", dark: "#d1d1d6" };

function edgeColor(
  model: CostModel | null,
  scheme: Scheme,
  profile: HeatProfile,
  relief: Relief,
): ExpressionSpecification | string {
  if (!model) return NO_DATA[scheme];
  return [
    "case",
    ["has", "heat_excess_sq_mean"],
    [
      "interpolate",
      ["linear"],
      heatFactorExpression(model, profile, relief),
      ...heatStops(model, scheme, profile).flat(),
    ],
    NO_DATA[scheme],
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
  model: CostModel | null,
  scheme: Scheme,
  profile: HeatProfile,
  relief: Relief,
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
        "line-color": ["case", selected, ACCENT[scheme], edgeColor(model, scheme, profile, relief)],
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

// Route comparison: the coolest route in blue, the shortest one dashed
export const ROUTE_SOURCE = "routes";
export const ROUTE_POINTS_SOURCE = "route-points";
export const ROUTE_COLOR: Record<"coolest" | "shortest", Record<Scheme, string>> = {
  coolest: { light: "#007aff", dark: "#0a84ff" },
  shortest: { light: "#3a3a3c", dark: "#e5e5ea" },
};
const emptyCollection = (): GeoJSON.FeatureCollection => ({ type: "FeatureCollection", features: [] });

function routeLayers(scheme: Scheme): LayerSpecification[] {
  const width = (w: number): ExpressionSpecification =>
    ["interpolate", ["exponential", 1.5], ["zoom"], 12, w, 16, w * 2, 19, w * 3.5];
  const isKind = (kind: string): ExpressionSpecification => ["==", ["get", "kind"], kind];
  return [
    {
      id: "route-casing",
      type: "line",
      source: ROUTE_SOURCE,
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": SURFACE[scheme], "line-width": width(5), "line-opacity": 0.9 },
    },
    {
      id: "route-shortest",
      type: "line",
      source: ROUTE_SOURCE,
      filter: isKind("shortest"),
      layout: { "line-cap": "butt", "line-join": "round" },
      paint: {
        "line-color": ROUTE_COLOR.shortest[scheme],
        "line-width": width(2.2),
        "line-dasharray": [1.5, 1.2],
      },
    },
    {
      id: "route-coolest",
      type: "line",
      source: ROUTE_SOURCE,
      filter: isKind("coolest"),
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": ROUTE_COLOR.coolest[scheme], "line-width": width(3) },
    },
    {
      id: "route-points",
      type: "circle",
      source: ROUTE_POINTS_SOURCE,
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 12, 5, 17, 8],
        "circle-color": ["match", ["get", "kind"], "start", SURFACE[scheme], ROUTE_COLOR.coolest[scheme]],
        "circle-stroke-color": ROUTE_COLOR.coolest[scheme],
        "circle-stroke-width": 3,
      },
    },
  ];
}

export function buildStyle(
  scheme: Scheme,
  model: CostModel | null,
  profile: HeatProfile,
  relief: Relief,
): StyleSpecification {
  const { below, above } = basemapLayers(scheme);
  const [glow, edges, nodes] = graphLayers(model, scheme, profile, relief);
  return {
    version: 8,
    glyphs: GLYPHS,
    sources: {
      ...BASEMAP_SOURCE,
      "graph-edges": { type: "geojson", data: EDGES_URL, promoteId: "id" },
      "graph-nodes": { type: "geojson", data: NODES_URL, promoteId: "id" },
      // filled by MapView with the route comparison
      [ROUTE_SOURCE]: { type: "geojson", data: emptyCollection() },
      [ROUTE_POINTS_SOURCE]: { type: "geojson", data: emptyCollection() },
    },
    layers: [...below, glow, edges, ...above, nodes, ...routeLayers(scheme)],
  };
}
