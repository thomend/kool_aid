import type { GraphMeta } from "../api";
import type { Scheme } from "../map/basemap";
import { costStops } from "../map/style";
import { formatLength } from "../format";
import { PROFILES, heatFactor, type HeatProfile } from "../profiles";
import { CaneIcon, InfoIcon, RunIcon, WalkIcon } from "./Icons";

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
  infoOpen: boolean;
  onToggleInfo: () => void;
}

export function Panel({ meta, scheme, profile, onProfileChange, infoOpen, onToggleInfo }: Props) {
  return (
    <aside className="panel glass">
      <header className="panel-header">
        <div className="app-icon">
          <WalkIcon />
        </div>
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
      <CostLegend meta={meta} scheme={scheme} />
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
  const factor = heatFactor(profile, 41);
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
      <p className="subtle small">
        A sunny street at 41 °C PET counts as {factor.toFixed(1).replace(/\.0$/, "")}× its length.
      </p>
    </section>
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
    </div>
  );
}
