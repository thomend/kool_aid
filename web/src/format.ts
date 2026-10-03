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
