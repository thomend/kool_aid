import type { CostModel, Factor, GraphMeta } from "../api";
import type { LiveLayout } from "../costLayout";
import type { CostSettings, EdgeCosts, FactorSetting } from "../cost";
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
  costModel: CostModel;
  costs: EdgeCosts;
  settings: CostSettings;
  onSettingsChange: (settings: CostSettings) => void;
  /** Live layout state, set while the cost-space view is active. */
  layout: LiveLayout | null;
}

export function Panel(props: Props) {
  const { meta, scheme, mode, onModeChange, costs, layout } = props;
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

      <CostSection {...props} />

      <section className="panel-section">
        <h2>Colour edges by</h2>
        <SegmentedControl
          label="Colour edges by"
          value={mode}
          onChange={onModeChange}
          options={[
            { value: "cost", label: "Cost" },
            { value: "perMetre", label: "Per metre" },
            { value: "type", label: "Path type" },
          ]}
        />
        {mode !== "type" ? (
          <CostLegend mode={mode} costs={costs} scheme={scheme} />
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

function CostSection({ costModel, settings, onSettingsChange }: Props) {
  const update = (key: string, change: Partial<FactorSetting>) =>
    onSettingsChange({ ...settings, [key]: { ...settings[key], ...change } });

  return (
    <section className="panel-section">
      <h2>Cost factors</h2>
      {costModel.factors.map((factor) => (
        <FactorCard
          key={factor.key}
          factor={factor}
          setting={settings[factor.key]}
          onChange={(change) => update(factor.key, change)}
        />
      ))}
    </section>
  );
}

function FactorCard({
  factor,
  setting,
  onChange,
}: {
  factor: Factor;
  setting: FactorSetting;
  onChange: (change: Partial<FactorSetting>) => void;
}) {
  const on = setting.enabled;
  return (
    <div className={`factor ${on ? "" : "off"}`}>
      <div className="factor-head">
        <button
          className="switch"
          role="switch"
          aria-checked={on}
          aria-label={`${factor.label} ${on ? "on" : "off"}`}
          onClick={() => onChange({ enabled: !on })}
        />
        <span title={factor.description}>{factor.label}</span>
      </div>
      {on && (
        <>
          {factor.variants.length > 1 && (
            <SegmentedControl
              label={`${factor.label} data`}
              value={setting.variant ?? ""}
              onChange={(variant) => onChange({ variant })}
              options={factor.variants.map((v) => ({ value: v.key, label: v.label }))}
            />
          )}
          <input
            type="range"
            min={0}
            max={factor.weight_max}
            step={factor.weight_max / 150}
            value={setting.weight}
            aria-label={`${factor.label} weight`}
            style={{ "--fill": `${(setting.weight / factor.weight_max) * 100}%` } as React.CSSProperties}
            onChange={(e) => onChange({ weight: Number(e.target.value) })}
          />
          <div className="factor-weight">
            <span>Weight</span>
            <span>
              {factor.transform === "constant"
                ? `each ${factor.unit} counts ×${setting.weight.toFixed(2)}`
                : `+${(setting.weight * 100).toFixed(1)} % per ${factor.unit}`}
            </span>
          </div>
        </>
      )}
    </div>
  );
}

function CostLegend({
  mode,
  costs,
  scheme,
}: {
  mode: "cost" | "perMetre";
  costs: EdgeCosts;
  scheme: Scheme;
}) {
  const stops = costStops(mode, scheme);
  const gradient = `linear-gradient(90deg, ${stops.map(([, c]) => c).join(", ")})`;
  return (
    <div className="legend">
      <div className="ramp" style={{ background: gradient }} />
      <div className="ramp-labels">
        {stops.map(([v], i) => (
          <span key={i}>
            {mode === "cost" ? formatLength(v) : `×${v}`}
            {i === stops.length - 1 ? "+" : ""}
          </span>
        ))}
      </div>
      <p className="subtle small">
        {mode === "cost"
          ? costs.isLength
            ? "Total cost of each edge; with distance only, its length."
            : "Total cost of each edge, from all active factors."
          : costs.isLength
            ? "Only distance counts: every metre counts once (×1)."
            : "How much each metre counts: ×2 = twice its length."}
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

function CostSpaceNote({ layout }: { layout: LiveLayout }) {
  const q = layout.quality;
  const spread = q ? Math.max(1 - q.edgeStretchP05, q.edgeStretchP95 - 1) : null;
  return (
    <section className="panel-section cost-note">
      <h2>
        Cost space
        {layout.running && <span className="layout-status">laying out…</span>}
      </h2>
      <p className="small">
        Every edge is drawn as long as its cost; expensive edges push the city apart.
      </p>
      <dl className="mini-stats">
        <div>
          <dt>Edge length vs cost</dt>
          <dd>{spread === null ? "–" : `±${Math.max(1, Math.round(spread * 100))} %`}</dd>
        </div>
        <div>
          <dt>Largest shift</dt>
          <dd>{q ? formatLength(q.displacementMaxM) : "–"}</dd>
        </div>
      </dl>
      <p className="footnote">Only the connected main network is shown.</p>
    </section>
  );
}
