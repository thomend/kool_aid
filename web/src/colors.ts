// Colours as RGBA arrays for deck.gl, matching the MapLibre style.

import type { GraphMeta } from "./api";
import type { Scheme } from "./map/basemap";
import { costStops } from "./map/style";

export type RGBA = [number, number, number, number];

export function hexToRgba(hex: string, alpha = 255): RGBA {
  const v = parseInt(hex.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255, alpha];
}

export function edgeColorFn(meta: GraphMeta, scheme: Scheme) {
  const stops = costStops(meta, scheme).map(([v, c]) => [v, hexToRgba(c)] as const);
  return (cost: number): RGBA => {
    if (cost <= stops[0][0]) return stops[0][1];
    for (let i = 1; i < stops.length; i++) {
      const [v1, c1] = stops[i];
      if (cost <= v1) {
        const [v0, c0] = stops[i - 1];
        const t = (cost - v0) / (v1 - v0);
        return c0.map((c, k) => Math.round(c + (c1[k] - c) * t)) as RGBA;
      }
    }
    return stops[stops.length - 1][1];
  };
}

// The edge width curve of the MapLibre style (exponential base 1.5),
// evaluated for a map zoom level; returns pixels for pedestrian edges.
const WIDTH_STOPS: [number, number][] = [
  [11, 0.6],
  [13, 1.1],
  [15, 2.2],
  [17, 4],
  [19, 8],
];

export function edgeWidthAtZoom(z: number): number {
  if (z <= WIDTH_STOPS[0][0]) return WIDTH_STOPS[0][1];
  for (let i = 1; i < WIDTH_STOPS.length; i++) {
    const [z1, w1] = WIDTH_STOPS[i];
    if (z <= z1) {
      const [z0, w0] = WIDTH_STOPS[i - 1];
      const t = (Math.pow(1.5, z - z0) - 1) / (Math.pow(1.5, z1 - z0) - 1);
      return w0 + (w1 - w0) * t;
    }
  }
  return WIDTH_STOPS[WIDTH_STOPS.length - 1][1];
}

export const STREET_WIDTH_RATIO = 0.75;
