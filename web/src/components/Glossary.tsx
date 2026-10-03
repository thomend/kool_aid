import { useEffect } from "react";
import type { GraphMeta, LayoutMeta } from "../api";
import type { Scheme } from "../map/basemap";
import { costStops } from "../map/style";
import { formatCount, formatLength } from "../format";
import { CloseIcon } from "./Icons";

interface Props {
  meta: GraphMeta;
  scheme: Scheme;
  /** Cost-space layout statistics, once the cost space has been loaded. */
  layout: LayoutMeta | null;
  onClose: () => void;
}

// Mirror of edge_cost() in scripts/build_layout.py
const PET_COMFORT_C = 23;
const PET_SCALE_C = 18;
const heatFactor = (pet: number) => 1 + Math.max(pet - PET_COMFORT_C, 0) / PET_SCALE_C;

// Heat-stress levels of the PET scale (VDI 3787 sheet 2), as [from, to) in degrees C
const PET_LEVELS: [number | null, number | null, string][] = [
  [null, 23, "None"],
  [23, 29, "Slight"],
  [29, 35, "Moderate"],
  [35, 41, "Strong"],
  [41, null, "Extreme"],
];

const cost100 = (pet: number) => Math.round(100 * heatFactor(pet));

export function Glossary({ meta, scheme, layout, onClose }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const types = meta.node_type_counts;
  return (
    <div className="glossary-backdrop" onClick={onClose}>
      <section
        className="glossary glass"
        role="dialog"
        aria-modal="true"
        aria-labelledby="glossary-title"
        onClick={(e) => e.stopPropagation()}
      >
        <button className="icon-button close" onClick={onClose} aria-label="Close glossary">
          <CloseIcon />
        </button>
        <p className="eyebrow">Glossary</p>
        <h2 id="glossary-title" className="glossary-title">
          How to read the map
        </h2>

        <section className="glossary-section">
          <h3>The network</h3>
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
          <dl className="terms">
            <dt>Network</dt>
            <dd>
              Every way in Basel you can walk on, from OpenStreetMap: footpaths, pedestrian zones,
              steps, and streets with a sidewalk. The figure is their total length.
            </dd>
            <dt>Node</dt>
            <dd>
              A point where edges meet. {formatCount(types.intersection ?? 0)} intersections (three
              or more edges), {formatCount(types.junction ?? 0)} junctions (two edges, e.g. where a
              way changes name or surface) and {formatCount(types.dead_end ?? 0)} dead ends. Nodes
              appear when you zoom in.
            </dd>
            <dt>Edge</dt>
            <dd>
              One stretch of path between two nodes, typically {formatLength(meta.length_quantiles_m.p50)}{" "}
              long. Click any edge or node on the map to inspect it.
            </dd>
            <dt>Disconnected pieces</dt>
            <dd>
              {meta.component_count - 1} small networks that do not connect to the main one (e.g.
              inside a courtyard). They are shown faded and left out of the cost space.
            </dd>
          </dl>
        </section>

        <section className="glossary-section">
          <h3>Cost</h3>
          <p>
            The cost of an edge is how much it takes to walk it, expressed in metres: its length,
            stretched by heat stress. A shaded, comfortable stretch costs exactly its length; a hot,
            exposed one costs up to about twice as much.
          </p>
          <p className="formula mono">
            cost = length × (1 + max(PET − {PET_COMFORT_C} °C, 0) / {PET_SCALE_C} °C)
          </p>
          <table className="glossary-table">
            <thead>
              <tr>
                <th>PET</th>
                <th>Heat stress</th>
                <th>100 m cost</th>
              </tr>
            </thead>
            <tbody>
              {PET_LEVELS.map(([from, to, label]) => (
                <tr key={label}>
                  <td>
                    {from === null ? `up to ${to}` : to === null ? `over ${from}` : `${from}–${to}`} °C
                  </td>
                  <td>{label}</td>
                  <td>
                    {from === null
                      ? "100"
                      : to === null
                        ? `over ${cost100(from)}`
                        : `${cost100(from)}–${cost100(to)}`}{" "}
                    m
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <dl className="terms">
            <dt>PET</dt>
            <dd>
              Physiological equivalent temperature: how hot it feels to a person, combining air
              temperature, humidity, wind and, above all, sun or shade. Thresholds follow VDI 3787.
            </dd>
            <dt>Where the heat comes from</dt>
            <dd>
              Stadtklimaanalyse Basel-Stadt (GEO-NET, 2019): a climate model of a hot, cloudless
              summer day at 14:00, on a 10 m grid at 2 m above ground. Each edge gets the mean PET
              along its whole length. Edges outside the model area cost their plain length.
            </dd>
          </dl>
          <CostLegend meta={meta} scheme={scheme} />
        </section>

        <section className="glossary-section">
          <h3>Views</h3>
          <dl className="terms">
            <dt>Geographic</dt>
            <dd>The network on a map of Basel, every edge at its real place and length.</dd>
            <dt>Cost space</dt>
            <dd>
              The same network redrawn so that every edge is as long as its cost, while nodes stay
              as close as possible to their real location. Hot, shadeless streets push the city
              apart; cool ones pull it together. Switching views animates between the two.
            </dd>
          </dl>
          {layout && (
            <dl className="mini-stats">
              <div>
                <dt>Edge length vs cost</dt>
                <dd>
                  ±
                  {Math.max(
                    1,
                    Math.round(
                      100 * Math.max(1 - layout.edge_stretch_p05, layout.edge_stretch_p95 - 1),
                    ),
                  )}{" "}
                  %
                </dd>
              </div>
              <div>
                <dt>Largest shift</dt>
                <dd>{formatLength(layout.displacement_max_m)}</dd>
              </div>
            </dl>
          )}
        </section>
      </section>
    </div>
  );
}

function CostLegend({ meta, scheme }: { meta: GraphMeta; scheme: Scheme }) {
  const stops = costStops(meta, scheme);
  const gradient = `linear-gradient(90deg, ${stops.map(([, c]) => c).join(", ")})`;
  return (
    <div className="legend">
      <h4>Edge colour</h4>
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
        Colour shows each edge’s total cost. Because cost grows with length, long edges look warm
        too; click an edge to see its PET.
      </p>
    </div>
  );
}
