export function formatLength(m: number): string {
  if (m >= 1000) return `${(m / 1000).toFixed(m >= 10000 ? 0 : 1)} km`;
  if (m < 10) return `${m.toFixed(1)} m`;
  return `${Math.round(m)} m`;
}

export function formatHighway(h: string): string {
  const s = h.replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function formatPet(c: number | null): string | null {
  return c === null ? null : `${Math.round(c)}°C PET`;
}

/** Cost per metre relative to the reference, e.g. "+25 % vs. typical". */
export function formatHeatRatio(factor: number, median: number): string {
  const pct = Math.round((factor / median - 1) * 100);
  if (Math.abs(pct) < 3) return "typical";
  return `${pct > 0 ? "+" : "−"}${Math.abs(pct)} % vs. typical`;
}

/** Tree shade of an edge, e.g. "60 % in tree shade · 12 trees nearby". */
export function formatTrees(count: number, shade: number): string {
  const trees = count === 0 ? "no trees nearby" : `${count} ${count === 1 ? "tree" : "trees"} nearby`;
  return shade > 0 ? `${Math.round(shade * 100)} % in tree shade · ${trees}` : `No tree shade · ${trees}`;
}

/** Nearest fountain of an edge, e.g. "Fountain 40 m away: Sevogel-Brunnen". */
export function formatFountain(name: string | null, distanceM: number): string {
  return `Fountain ${formatLength(distanceM)} away${name ? `: ${name}` : ""}`;
}

/** Gradient of an edge, e.g. "Gradient 6 % (steepest 11 %)". */
export function formatGrade(mean: number, max: number): string {
  if (max < 0.02) return "Flat";
  const pct = (g: number) => `${Math.round(g * 100)} %`;
  return `Gradient ${pct(mean)}${max >= mean + 0.02 ? ` (steepest ${pct(max)})` : ""}`;
}
