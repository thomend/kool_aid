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

/** Heat cost per metre relative to the city median, e.g. "+25 % vs. typical". */
export function formatHeatRatio(factor: number, median: number): string {
  const pct = Math.round((factor / median - 1) * 100);
  if (Math.abs(pct) < 3) return "typical heat";
  return `${pct > 0 ? "+" : "−"}${Math.abs(pct)} % heat vs. typical`;
}
