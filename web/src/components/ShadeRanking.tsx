import { useEffect, useState } from "react";
import { fetchLeverage, type LeverageItem } from "../api";
import { categoryOf } from "../map/style";
import { formatLength } from "../format";
import type { HeatProfile } from "../profiles";
import { ChevronIcon } from "./Icons";

interface Props {
  profile: HeatProfile;
  onPick: (item: LeverageItem) => void;
}

const SHOWN = 10;

// Streets where shade would help walkers most, see scripts/build_leverage.py
export function ShadeRanking({ profile, onPick }: Props) {
  const [items, setItems] = useState<{ profile: HeatProfile; list: LeverageItem[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    setError(null);
    fetchLeverage(profile, ctrl.signal)
      .then((list) => setItems({ profile, list }))
      .catch((e: Error) => {
        if (e.name !== "AbortError") setError(e.message);
      });
    return () => ctrl.abort();
  }, [profile]);

  const list = items?.profile === profile ? items.list.slice(0, SHOWN) : null;
  return (
    <section className="ranking glass" aria-label="Where shade helps most">
      <p className="eyebrow">Shade priority</p>
      <h3>Where shade helps most</h3>
      {error ? (
        <p className="subtle small">Could not load the ranking: {error}</p>
      ) : !list ? (
        <div className="skeleton" />
      ) : (
        <ol className="list ranking-list">
          {list.map((item, i) => (
            <li key={item.edge_id}>
              <button onClick={() => onPick(item)}>
                <span className="ranking-index">{i + 1}</span>
                <span className="list-label">
                  {item.street_name ?? categoryOf(item.highway).label}
                  {!item.street_name && item.near_street && (
                    <span className="subtle"> at {item.near_street}</span>
                  )}
                  <span className="ranking-detail">
                    {formatLength(item.length_m)}
                    {item.pet_mean_c !== null && ` · ${Math.round(item.pet_mean_c)} °C PET`}
                  </span>
                </span>
                <span className="list-value">{item.share_pct.toFixed(1)} %</span>
                <ChevronIcon />
              </button>
            </li>
          ))}
        </ol>
      )}
      <p className="footnote">
        Share of the heat that shade would remove from everyday walks, for this heat sensitivity.
      </p>
    </section>
  );
}
