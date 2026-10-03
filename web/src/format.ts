const int = new Intl.NumberFormat("de-CH");

export function formatLength(m: number): string {
  if (m >= 1000) return `${(m / 1000).toFixed(m >= 10000 ? 0 : 1)} km`;
  if (m < 10) return `${m.toFixed(1)} m`;
  return `${Math.round(m)} m`;
}

export function formatCount(n: number): string {
  return int.format(n);
}

export function formatHighway(h: string): string {
  const s = h.replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Rank of an edge's leverage, e.g. "top 3 %"; null where shade would not help. */
export function formatLeverage(pct: number | null | undefined): string | null {
  if (!pct) return null;
  return `top ${Math.max(1, Math.ceil(100 - pct))} % for shade`;
}

export function formatPet(c: number | null): string | null {
  return c === null ? null : `${Math.round(c)}°C PET`;
}
