import { PROFILES, heatFactor, type HeatProfile } from "../profiles";
import { BookIcon, CaneIcon, RunIcon, WalkIcon } from "./Icons";

const PROFILE_ICONS: Record<HeatProfile, () => React.JSX.Element> = {
  low: RunIcon,
  medium: WalkIcon,
  high: CaneIcon,
};

interface Props {
  profile: HeatProfile;
  onProfileChange: (profile: HeatProfile) => void;
  onOpenGlossary: () => void;
}

export function Panel({ profile, onProfileChange, onOpenGlossary }: Props) {
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
          className="icon-button glossary-button"
          onClick={onOpenGlossary}
          aria-label="Open glossary"
          title="Glossary"
        >
          <BookIcon />
        </button>
      </header>
      <ProfilePicker profile={profile} onChange={onProfileChange} />
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
