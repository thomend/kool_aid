// Map icons for the cost factors: the toggle buttons' symbols (components/Icons.tsx)
// on a coloured badge, drawn synchronously with Path2D so MapLibre can add them
// whenever the style asks for one (styleimagemissing, also after a restyle).

import { DROP_PATHS, SLOPE_PATHS, TREE_PATHS } from "../components/Icons";
import type { Scheme } from "./basemap";

export type FactorKind = "tree" | "fountain" | "slope";

export const FACTOR_COLOR: Record<FactorKind, Record<Scheme, string>> = {
  tree: { light: "#34c759", dark: "#30d158" },
  fountain: { light: "#32ade6", dark: "#64d2ff" },
  slope: { light: "#a2845e", dark: "#ac8e68" },
};

const PATHS: Record<FactorKind, string[]> = { tree: TREE_PATHS, fountain: DROP_PATHS, slope: SLOPE_PATHS };

export const factorIconId = (kind: FactorKind, scheme: Scheme) => `factor-${kind}-${scheme}`;

const SIZE = 22; // CSS pixels
const PIXEL_RATIO = 2;

/** The icon for an id from factorIconId, or null for any other id. */
export function factorIcon(id: string): { image: ImageData; pixelRatio: number } | null {
  const match = /^factor-(tree|fountain|slope)-(light|dark)$/.exec(id);
  if (!match) return null;
  const [, kind, scheme] = match as unknown as [string, FactorKind, Scheme];
  const px = SIZE * PIXEL_RATIO;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = px;
  const ctx = canvas.getContext("2d")!;
  // badge: factor colour with a white ring, readable on any street colour
  ctx.beginPath();
  ctx.arc(px / 2, px / 2, px / 2 - 1, 0, 2 * Math.PI);
  ctx.fillStyle = "#ffffff";
  ctx.fill();
  ctx.beginPath();
  ctx.arc(px / 2, px / 2, px / 2 - 4, 0, 2 * Math.PI);
  ctx.fillStyle = FACTOR_COLOR[kind][scheme];
  ctx.fill();
  // the 24-unit symbol, scaled into the badge
  const scale = (px * 0.6) / 24;
  ctx.translate(px * 0.2, px * 0.2);
  ctx.scale(scale, scale);
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 2.4;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const d of PATHS[kind]) ctx.stroke(new Path2D(d));
  return { image: ctx.getImageData(0, 0, px, px), pixelRatio: PIXEL_RATIO };
}
