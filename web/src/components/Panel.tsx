import type { GraphMeta } from "../api";
import type { Scheme } from "../map/basemap";
import { HEAT_RATIOS, heatStops } from "../map/style";
import { PROFILES, type HeatProfile } from "../profiles";
import type { Factors } from "../costModel";
import { CaneIcon, DropIcon, InfoIcon, RunIcon, SlopeIcon, TreeIcon, WalkIcon } from "./Icons";

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
  factors: Factors;
  onFactorsChange: (factors: Factors) => void;
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
  factors,
  onFactorsChange,
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
      <ProfilePicker profile={profile} onChange={onProfileChange} />
      <FactorToggles factors={factors} onChange={onFactorsChange} />
      {children}
      <HeatLegend meta={meta} scheme={scheme} profile={profile} />
    </aside>
  );
}

function ProfilePicker({
  profile,
  onChange,
}: {
  profile: HeatProfile;
  onChange: (profile: HeatProfile) => void;
}) {
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
    </section>
  );
}

const FACTOR_TOGGLES = [
  { key: "trees", label: "Tree shade", Icon: TreeIcon },
  { key: "fountains", label: "Fountains", Icon: DropIcon },
  { key: "slope", label: "Slope", Icon: SlopeIcon },
] as const;

function FactorToggles({ factors, onChange }: { factors: Factors; onChange: (factors: Factors) => void }) {
  return (
    <section className="panel-section">
      <h2>Count in</h2>
      <div className="profiles">
        {FACTOR_TOGGLES.map(({ key, label, Icon }) => (
          <button
            key={key}
            aria-pressed={factors[key]}
            className={`profile ${factors[key] ? "active" : ""}`}
            onClick={() => onChange({ ...factors, [key]: !factors[key] })}
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
  return (
    <section className="panel-section">
      <h2>Cost per metre</h2>
      <div className="legend">
        <div className="ramp" style={{ background: gradient }} />
        <div className="ramp-labels">
          {HEAT_RATIOS.map((r) => (
            <span key={r}>{r === 1 ? "typical" : `${r > 1 ? "+" : "−"}${Math.round(Math.abs(r - 1) * 100)} %`}</span>
          ))}
        </div>
      </div>
    </section>
  );
}
