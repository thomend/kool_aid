// Coordinate helpers shared by the geographic (MapLibre) and cost-space
// (deck.gl, metres) views, so both cameras can show the same place.

// swisstopo approximate formulas, accurate to about 1 m
export function wgs84ToLv95(lon: number, lat: number): [number, number] {
  const p = (lat * 3600 - 169028.66) / 10000;
  const l = (lon * 3600 - 26782.5) / 10000;
  const e = 2600072.37 + 211455.93 * l - 10938.51 * l * p - 0.36 * l * p * p - 44.54 * l ** 3;
  const n =
    1200147.07 + 308807.95 * p + 3745.25 * l * l + 76.63 * p * p - 194.56 * l * l * p + 119.79 * p ** 3;
  return [e, n];
}

export function lv95ToWgs84(e: number, n: number): [number, number] {
  const y = (e - 2600000) / 1e6;
  const x = (n - 1200000) / 1e6;
  const l = 2.6779094 + 4.728982 * y + 0.791484 * y * x + 0.1306 * y * x * x - 0.0436 * y ** 3;
  const p = 16.9023892 + 3.238272 * x - 0.270978 * y * y - 0.002528 * x * x - 0.0447 * y * y * x - 0.014 * x ** 3;
  return [(l * 100) / 36, (p * 100) / 36];
}

const EARTH_CIRCUMFERENCE = 40075016.686;
const BASEL_LAT = 47.56;

// MapLibre zoom z shows 512 * 2^z pixels per Mercator world width; deck.gl's
// orthographic zoom Z shows 2^Z pixels per metre.
const ZOOM_OFFSET = Math.log2(512 / (EARTH_CIRCUMFERENCE * Math.cos((BASEL_LAT * Math.PI) / 180)));

export const mapZoomToDeck = (z: number) => z + ZOOM_OFFSET;
export const deckZoomToMap = (z: number) => z - ZOOM_OFFSET;
