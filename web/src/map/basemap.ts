// A calm, abstract basemap of Basel drawn from OpenFreeMap vector tiles
// (OpenMapTiles schema). Streets stay faint: the walkable graph is the hero.

import type { LayerSpecification, SourceSpecification } from "@maplibre/maplibre-gl-style-spec";

export type Scheme = "light" | "dark";

const PALETTES = {
  light: {
    land: "#f4f2ee",
    park: "#d9ecd0",
    wood: "#cfe5c4",
    water: "#a9d2f3",
    waterLine: "#94c4ec",
    building: "#e7e3dc",
    buildingOutline: "#ddd8cf",
    road: "#ffffff",
    roadCasing: "#e6e1d8",
    rail: "#d6d1c8",
    label: "#6e6e73",
    labelStrong: "#3a3a3c",
    waterLabel: "#4f86b8",
    halo: "rgba(244,242,238,0.9)",
  },
  dark: {
    land: "#1b1c1f",
    park: "#1d2a22",
    wood: "#1f2d24",
    water: "#1a2c40",
    waterLine: "#22384f",
    building: "#26272b",
    buildingOutline: "#2e2f34",
    road: "#2b2d31",
    roadCasing: "#232428",
    rail: "#303136",
    label: "#8e8e93",
    labelStrong: "#c7c7cc",
    waterLabel: "#6f9ac4",
    halo: "rgba(27,28,31,0.9)",
  },
} as const;

export const BASEMAP_SOURCE: Record<string, SourceSpecification> = {
  openmaptiles: { type: "vector", url: "https://tiles.openfreemap.org/planet" },
};

export const GLYPHS = "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf";

const FONT = ["Noto Sans Regular"];
const FONT_BOLD = ["Noto Sans Bold"];
const FONT_ITALIC = ["Noto Sans Italic"];

const minorRoads = ["minor", "service", "track", "path"];

export function basemapLayers(scheme: Scheme): {
  below: LayerSpecification[];
  above: LayerSpecification[];
} {
  const c = PALETTES[scheme];
  const src = "openmaptiles";

  const below: LayerSpecification[] = [
    { id: "background", type: "background", paint: { "background-color": c.land } },
    {
      id: "landcover-wood",
      type: "fill",
      source: src,
      "source-layer": "landcover",
      filter: ["in", ["get", "class"], ["literal", ["wood", "forest"]]],
      paint: { "fill-color": c.wood, "fill-opacity": 0.8 },
    },
    {
      id: "landcover-grass",
      type: "fill",
      source: src,
      "source-layer": "landcover",
      filter: ["in", ["get", "class"], ["literal", ["grass", "farmland", "meadow"]]],
      paint: { "fill-color": c.park, "fill-opacity": 0.55 },
    },
    {
      id: "landuse-green",
      type: "fill",
      source: src,
      "source-layer": "landuse",
      filter: ["in", ["get", "class"], ["literal", ["cemetery", "pitch", "playground", "stadium"]]],
      paint: { "fill-color": c.park, "fill-opacity": 0.6 },
    },
    {
      id: "park",
      type: "fill",
      source: src,
      "source-layer": "park",
      paint: { "fill-color": c.park, "fill-opacity": 0.85 },
    },
    {
      id: "water",
      type: "fill",
      source: src,
      "source-layer": "water",
      paint: { "fill-color": c.water },
    },
    {
      id: "waterway",
      type: "line",
      source: src,
      "source-layer": "waterway",
      paint: {
        "line-color": c.waterLine,
        "line-width": ["interpolate", ["linear"], ["zoom"], 12, 0.8, 16, 3],
      },
    },
    {
      id: "building",
      type: "fill",
      source: src,
      "source-layer": "building",
      minzoom: 13,
      paint: {
        "fill-color": c.building,
        "fill-outline-color": c.buildingOutline,
        "fill-opacity": ["interpolate", ["linear"], ["zoom"], 13, 0, 14.5, 1],
      },
    },
    {
      id: "rail",
      type: "line",
      source: src,
      "source-layer": "transportation",
      filter: ["==", ["get", "class"], "rail"],
      paint: {
        "line-color": c.rail,
        "line-width": ["interpolate", ["linear"], ["zoom"], 12, 0.6, 17, 2],
        "line-dasharray": [3, 3],
      },
    },
    {
      id: "road-major",
      type: "line",
      source: src,
      "source-layer": "transportation",
      filter: ["in", ["get", "class"], ["literal", ["motorway", "trunk", "primary", "secondary"]]],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": c.road,
        "line-width": ["interpolate", ["exponential", 1.6], ["zoom"], 11, 1, 18, 22],
        "line-opacity": 0.9,
      },
    },
    {
      id: "road-minor",
      type: "line",
      source: src,
      "source-layer": "transportation",
      filter: ["in", ["get", "class"], ["literal", ["tertiary", ...minorRoads]]],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": c.road,
        "line-width": ["interpolate", ["exponential", 1.6], ["zoom"], 12, 0.5, 18, 14],
        "line-opacity": 0.75,
      },
    },
  ];

  const above: LayerSpecification[] = [
    {
      id: "water-name",
      type: "symbol",
      source: src,
      "source-layer": "water_name",
      layout: {
        "text-field": ["coalesce", ["get", "name:de"], ["get", "name"]],
        "text-font": FONT_ITALIC,
        "text-size": 13,
        "text-letter-spacing": 0.2,
        "symbol-placement": "line",
        "symbol-spacing": 400,
      },
      paint: { "text-color": c.waterLabel, "text-halo-color": c.halo, "text-halo-width": 1 },
    },
    {
      id: "street-name",
      type: "symbol",
      source: src,
      "source-layer": "transportation_name",
      minzoom: 16,
      layout: {
        "text-field": ["get", "name"],
        "text-font": FONT,
        "text-size": 11,
        "symbol-placement": "line",
      },
      paint: { "text-color": c.label, "text-halo-color": c.halo, "text-halo-width": 1.5 },
    },
    {
      id: "place-quarter",
      type: "symbol",
      source: src,
      "source-layer": "place",
      minzoom: 12,
      filter: ["in", ["get", "class"], ["literal", ["suburb", "quarter", "neighbourhood"]]],
      layout: {
        "text-field": ["coalesce", ["get", "name:de"], ["get", "name"]],
        "text-font": FONT_BOLD,
        "text-size": ["interpolate", ["linear"], ["zoom"], 12, 10, 16, 13],
        "text-transform": "uppercase",
        "text-letter-spacing": 0.12,
        "text-max-width": 8,
      },
      paint: { "text-color": c.label, "text-halo-color": c.halo, "text-halo-width": 1.5 },
    },
    {
      id: "place-city",
      type: "symbol",
      source: src,
      "source-layer": "place",
      maxzoom: 13,
      filter: ["in", ["get", "class"], ["literal", ["city", "town"]]],
      layout: {
        "text-field": ["coalesce", ["get", "name:de"], ["get", "name"]],
        "text-font": FONT_BOLD,
        "text-size": 16,
      },
      paint: { "text-color": c.labelStrong, "text-halo-color": c.halo, "text-halo-width": 2 },
    },
  ];

  return { below, above };
}
