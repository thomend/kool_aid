import type { Route, RouteComparison } from "../api";
import { formatLength } from "../format";
import { ROUTE_COLOR } from "../map/style";
import type { Scheme } from "../map/basemap";

export type RoutePicking = "off" | "start" | "end";

interface Props {
  scheme: Scheme;
  picking: RoutePicking;
  onPick: () => void;
  onClear: () => void;
  /** Picking only works on the (unwarped) map. */
  canPick: boolean;
  routes: RouteComparison | null;
  loading: boolean;
  error: string | null;
}

export function RouteSection({ scheme, picking, onPick, onClear, canPick, routes, loading, error }: Props) {
  const hint =
    picking === "start"
      ? "Click the start on the map. Esc to stop."
      : picking === "end"
        ? "Now click the destination."
        : !canPick
          ? "Switch to the geographic view to pick points."
          : "The shortest and the coolest walk between two points, e.g. a school route.";
  return (
    <section className="panel-section">
      <h2>Compare routes</h2>
      <div className="route-actions">
        <button className="pill-button" disabled={!canPick} onClick={onPick} aria-pressed={picking !== "off"}>
          {routes ? "Pick new points" : "Pick start and destination"}
        </button>
        {(routes || error) && (
          <button className="text-button" onClick={onClear}>
            Clear
          </button>
        )}
      </div>
      <p className="subtle small">{hint}</p>
      {loading && <p className="subtle small">Finding routes…</p>}
      {error && <p className="small route-error">{error}</p>}
      {routes && !loading && <RouteResult routes={routes} scheme={scheme} />}
    </section>
  );
}

function RouteResult({ routes, scheme }: { routes: RouteComparison; scheme: Scheme }) {
  const { shortest, coolest } = routes;
  const same = shortest.edges.join() === coolest.edges.join();
  // heat stress = what the heat adds to the walking cost
  const heatShortest = shortest.cost_m - shortest.length_m;
  const heatCoolest = coolest.cost_m - coolest.length_m;
  const avoided = heatShortest > 0 ? Math.round((1 - heatCoolest / heatShortest) * 100) : 0;
  const longer = coolest.length_m - shortest.length_m;
  return (
    <>
      <ul className="route-list">
        <RouteRow label="Coolest" route={coolest} color={ROUTE_COLOR.coolest[scheme]} />
        {!same && <RouteRow label="Shortest" route={shortest} color={ROUTE_COLOR.shortest[scheme]} dashed />}
      </ul>
      <p className="small">
        {same
          ? "The shortest route is already the coolest one."
          : `The cool route is ${formatLength(longer)} (${Math.max(1, Math.round(coolest.minutes - shortest.minutes))} min) ` +
            `longer and avoids ${avoided} % of the heat stress.`}
      </p>
    </>
  );
}

function RouteRow({ label, route, color, dashed }: { label: string; route: Route; color: string; dashed?: boolean }) {
  return (
    <li>
      <span className={`route-swatch ${dashed ? "dashed" : ""}`} style={{ "--swatch": color } as React.CSSProperties} />
      <span className="route-label">{label}</span>
      <span className="route-value">
        {formatLength(route.length_m)} · {Math.round(route.minutes)} min · {Math.round(route.shade_share * 100)} % shade
      </span>
    </li>
  );
}
