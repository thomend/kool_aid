import type { CostModel, GraphMeta } from "../api";
import type { Scheme } from "../map/basemap";
import { HEAT_RATIOS, heatStops } from "../map/style";
import { PROFILES, type HeatProfile } from "../profiles";
import { NO_RELIEF, heatFactor, referenceMedian, type Relief } from "../costModel";
import { CaneIcon, DropIcon, InfoIcon, RunIcon, TreeIcon, WalkIcon } from "./Icons";

const PROFILE_ICONS: Record<HeatProfile, () => React.JSX.Element> = {
  low: RunIcon,
  medium: WalkIcon,
  high: CaneIcon,
};

interface Props {
  meta: GraphMeta;
  scheme: Scheme;
  profile: HeatProfile;
  onProfileChange: (profile: HeatProfile) => void;
  relief: Relief;
  onReliefChange: (relief: Relief) => void;
  infoOpen: boolean;
  onToggleInfo: () => void;
  /** Extra sections (route comparison), shown above the legend. */
  children?: React.ReactNode;
}

export function Panel({
  meta,
  scheme,
  profile,
  onProfileChange,
  relief,
  onReliefChange,
  infoOpen,
  onToggleInfo,
  children,
}: Props) {
  return (
    <aside className="panel glass">
      <header className="panel-header">
        <div className="panel-title">
          <h1>Walkable Basel</h1>
          <p className="subtle">Walking cost under heat stress</p>
        </div>
        <button
          className={`info-button ${infoOpen ? "active" : ""}`}
          aria-label="About this map"
          aria-expanded={infoOpen}
          onClick={onToggleInfo}
        >
          <InfoIcon />
        </button>
      </header>
      <ProfilePicker model={meta.cost_model} profile={profile} onChange={onProfileChange} />
      <ReliefToggles relief={relief} onChange={onReliefChange} />
      {children}
      <HeatLegend meta={meta} scheme={scheme} profile={profile} />
    </aside>
  );
}

function ProfilePicker({
  model,
  profile,
  onChange,
}: {
  model: CostModel | null;
  profile: HeatProfile;
  onChange: (profile: HeatProfile) => void;
}) {
  // an unshaded street at 41 °C PET, for the caption
  const factor = model && heatFactor(model, profile, NO_RELIEF, (41 - model.pet_threshold_c) ** 2, 0, 0);
  return (
    <section className="panel-section">
      <h2 id="heat-sensitivity">Heat sensitivity</h2>
      <div className="profiles" role="radiogroup" aria-labelledby="heat-sensitivity">
        {PROFILES.map(({ key, label }) => {
          const Icon = PROFILE_ICONS[key];
          return (
            <button
              key={key}
              role="radio"
              aria-checked={key === profile}
              className={`profile ${key === profile ? "active" : ""}`}
              onClick={() => onChange(key)}
            >
              <span className="profile-icon">
                <Icon />
              </span>
              {label}
            </button>
          );
        })}
      </div>
      {factor && (
        <p className="subtle small">
          A sunny street at 41 °C PET counts as {factor.toFixed(1).replace(/\.0$/, "")}× its length.
        </p>
      )}
    </section>
  );
}

const RELIEF_TOGGLES = [
  { key: "trees", label: "Tree shade", Icon: TreeIcon },
  { key: "fountains", label: "Fountains", Icon: DropIcon },
] as const;

function ReliefToggles({ relief, onChange }: { relief: Relief; onChange: (relief: Relief) => void }) {
  return (
    <section className="panel-section">
      <h2>Count in</h2>
      <div className="profiles toggles">
        {RELIEF_TOGGLES.map(({ key, label, Icon }) => (
          <button
            key={key}
            aria-pressed={relief[key]}
            className={`profile ${relief[key] ? "active" : ""}`}
            onClick={() => onChange({ ...relief, [key]: !relief[key] })}
          >
            <span className="profile-icon">
              <Icon />
            </span>
            {label}
          </button>
        ))}
      </div>
    </section>
  );
}

function HeatLegend({ meta, scheme, profile }: { meta: GraphMeta; scheme: Scheme; profile: HeatProfile }) {
  const model = meta.cost_model;
  if (!model) return null;
  const stops = heatStops(model, scheme, profile);
  const gradient = `linear-gradient(90deg, ${stops.map(([, c]) => c).join(", ")})`;
  const reference = referenceMedian(model, profile);
  return (
    <section className="panel-section">
      <h2>Heat cost per metre</h2>
      <div className="legend">
        <div className="ramp" style={{ background: gradient }} />
        <div className="ramp-labels">
          {HEAT_RATIOS.map((r) => (
            <span key={r}>{r === 1 ? "typical" : `${r > 1 ? "+" : "−"}${Math.round(Math.abs(r - 1) * 100)} %`}</span>
          ))}
        </div>
        <p className="subtle small">
          Compared with a typical metre of Basel without trees and fountains, which costs{" "}
          {reference.toFixed(1)}× its length.
        </p>
      </div>
    </section>
  );
}
