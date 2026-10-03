import type { GraphMeta, LayoutMeta } from "../api";
import type { Scheme } from "../map/basemap";
import { EDGE_CATEGORIES, categoryOf, costStops, type ColorMode } from "../map/style";
import { formatCount, formatLength } from "../format";
import { SegmentedControl } from "./SegmentedControl";
import { WalkIcon } from "./Icons";

interface Props {
  meta: GraphMeta;
  scheme: Scheme;
  mode: ColorMode;
  onModeChange: (mode: ColorMode) => void;
  /** Set while the cost-space view is active. */
  layout: LayoutMeta | null;
}

export function Panel({ meta, scheme, mode, onModeChange, layout }: Props) {
  return (
    <aside className="panel glass">
      <header className="panel-header">
        <div className="app-icon">
          <WalkIcon />
        </div>
        <div>
          <h1>Walkable Basel</h1>
          <p className="subtle">Pedestrian network graph</p>
        </div>
      </header>

      <dl className="stats">
        <div>
          <dt>Network</dt>
          <dd>
            {Math.round(meta.total_length_km)}
            <span> km</span>
          </dd>
        </div>
        <div>
          <dt>Nodes</dt>
          <dd>{formatCount(meta.node_count)}</dd>
        </div>
        <div>
          <dt>Edges</dt>
          <dd>{formatCount(meta.edge_count)}</dd>
        </div>
      </dl>

      <section className="panel-section">
        <h2>Colour edges by</h2>
        <SegmentedControl
          label="Colour edges by"
          value={mode}
          onChange={onModeChange}
          options={[
            { value: "cost", label: "Cost" },
            { value: "type", label: "Path type" },
          ]}
        />
        {mode === "cost" ? (
          <CostLegend meta={meta} scheme={scheme} />
        ) : (
          <TypeLegend meta={meta} scheme={scheme} />
        )}
      </section>

      {layout ? (
        <CostSpaceNote layout={layout} />
      ) : (
        <p className="footnote">
          {meta.component_count - 1} small disconnected pieces are shown faded. Zoom in to see
          intersections.
        </p>
      )}
    </aside>
  );
}

function CostLegend({ meta, scheme }: { meta: GraphMeta; scheme: Scheme }) {
  const stops = costStops(meta, scheme);
  const gradient = `linear-gradient(90deg, ${stops.map(([, c]) => c).join(", ")})`;
  return (
    <div className="legend">
      <div className="ramp" style={{ background: gradient }} />
      <div className="ramp-labels">
        {stops.map(([v], i) => (
          <span key={i}>
            {formatLength(v)}
            {i === stops.length - 1 ? "+" : ""}
          </span>
        ))}
      </div>
      <p className="subtle small">
        Cost is length stretched by heat stress (PET), so hot streets cost more to walk.
      </p>
    </div>
  );
}

function TypeLegend({ meta, scheme }: { meta: GraphMeta; scheme: Scheme }) {
  const counts: Record<string, number> = {};
  for (const [highway, n] of Object.entries(meta.highway_counts)) {
    const key = categoryOf(highway).key;
    counts[key] = (counts[key] ?? 0) + n;
  }
  return (
    <ul className="legend type-legend">
      {EDGE_CATEGORIES.map((c) => (
        <li key={c.key}>
          <span className="swatch" style={{ background: c.color[scheme] }} />
          <span className="legend-label">{c.label}</span>
          <span className="legend-count">{formatCount(counts[c.key] ?? 0)}</span>
        </li>
      ))}
    </ul>
  );
}

function CostSpaceNote({ layout }: { layout: LayoutMeta }) {
  const spread = Math.max(1 - layout.edge_stretch_p05, layout.edge_stretch_p95 - 1);
  return (
    <section className="panel-section cost-note">
      <h2>Cost space</h2>
      <p className="small">
        Every edge is drawn as long as its cost, and nodes are gently pulled toward their real
        location. Expensive edges push the city apart.
      </p>
      <p className="small subtle">
        Cost is length stretched by heat stress (PET), so hot, shadeless streets push the city
        apart and cool, comfortable ones pull it back together.
      </p>
      <dl className="mini-stats">
        <div>
          <dt>Edge length vs cost</dt>
          <dd>±{Math.max(1, Math.round(spread * 100))} %</dd>
        </div>
        <div>
          <dt>Largest shift</dt>
          <dd>{formatLength(layout.displacement_max_m)}</dd>
        </div>
      </dl>
      <p className="footnote">Only the connected main network is shown.</p>
    </section>
  );
}
