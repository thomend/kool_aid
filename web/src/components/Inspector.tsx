import { useEffect, useState } from "react";
import {
  fetchEdge,
  fetchNode,
  type CostModel,
  type EdgeSummary,
  type GraphMeta,
  type NodeDetail,
} from "../api";
import { costFactor, referenceMedian, type Factors } from "../costModel";
import { edgeColorFn } from "../colors";
import type { Scheme } from "../map/basemap";
import { categoryOf } from "../map/style";
import { formatGrade, formatHeatRatio, formatHighway, formatLength } from "../format";
import type { HeatProfile } from "../profiles";
import type { Selection } from "./MapView";
import { ChevronIcon, CloseIcon, DropIcon, SlopeIcon, SunIcon, TreeIcon } from "./Icons";

interface Props {
  selection: NonNullable<Selection>;
  meta: GraphMeta;
  scheme: Scheme;
  profile: HeatProfile;
  factors: Factors;
  onSelect: (s: Selection, focus?: boolean) => void;
  onNodeLoaded: (node: NodeDetail) => void;
}

type Loaded =
  | { kind: "node"; data: NodeDetail }
  | { kind: "edge"; data: EdgeSummary }
  | { kind: "error"; message: string };

export function Inspector({ selection, meta, scheme, profile, factors, onSelect, onNodeLoaded }: Props) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    const request =
      selection.kind === "node"
        ? fetchNode(selection.id, ctrl.signal).then((data) => {
            onNodeLoaded(data);
            return { kind: "node", data } as const;
          })
        : fetchEdge(selection.id, ctrl.signal).then((data) => ({ kind: "edge", data }) as const);
    request
      .then(setLoaded)
      .catch((e: Error) => {
        if (e.name !== "AbortError") setLoaded({ kind: "error", message: e.message });
      });
    return () => ctrl.abort();
    // refetch only when the selection changes, not when the callback identity does
  }, [selection.kind, selection.id]);

  const current =
    loaded && loaded.kind !== "error" && loaded.data.id === selection.id && loaded.kind === selection.kind
      ? loaded
      : null;
  const cost: CostContext = { model: meta.cost_model, scheme, profile, factors };

  return (
    <section className="inspector glass" aria-live="polite">
      <button className="icon-button close" onClick={() => onSelect(null)} aria-label="Close">
        <CloseIcon />
      </button>
      {loaded?.kind === "error" ? (
        <p className="subtle">Could not load details: {loaded.message}</p>
      ) : !current ? (
        <div className="skeleton" />
      ) : current.kind === "edge" ? (
        <EdgeCard edge={current.data} cost={cost} />
      ) : (
        <NodeCard node={current.data} cost={cost} onSelect={onSelect} />
      )}
    </section>
  );
}

interface CostContext {
  model: CostModel | null;
  scheme: Scheme;
  profile: HeatProfile;
  factors: Factors;
}

/** Cost per metre of an edge for some factors, or null outside the main network. */
function perMetre(edge: EdgeSummary, { model, profile }: CostContext, factors: Factors) {
  if (!model || edge.heat_excess_sq_mean === null) return null;
  return costFactor(
    model,
    profile,
    factors,
    edge.heat_excess_sq_mean,
    edge.shade_share,
    edge.fountain_share,
    edge.slope_excess,
  );
}

/** Coloured dot and "+25 % vs. typical" for a cost per metre, in the legend's colours. */
function Rating({ factor, cost }: { factor: number; cost: CostContext }) {
  const { model, scheme, profile } = cost;
  if (!model) return null;
  const [r, g, b] = edgeColorFn(model, scheme, profile)(factor);
  return (
    <span className="rating">
      <span className="dot" style={{ background: `rgb(${r}, ${g}, ${b})` }} aria-hidden />
      {formatHeatRatio(factor, referenceMedian(model, profile))}
    </span>
  );
}

const signed = (m: number) => (Math.abs(m) < 0.5 ? "±0 m" : `${m > 0 ? "+" : "−"}${formatLength(Math.abs(m))}`);

function EdgeCard({ edge, cost }: { edge: EdgeSummary; cost: CostContext }) {
  const { trees, fountains, slope } = cost.factors;
  const factor = perMetre(edge, cost, { trees, fountains, slope });
  return (
    <>
      <p className="eyebrow">Street</p>
      <h3>{edge.street_name ?? categoryOf(edge.highway).label}</h3>
      <div className="chips">
        <span className="chip">{formatHighway(edge.highway)}</span>
        {edge.component !== 0 && <span className="chip">Disconnected</span>}
        {factor !== null && (
          <span className="chip">
            <Rating factor={factor} cost={cost} />
          </span>
        )}
      </div>
      <div className="big-number">
        {formatLength(edge.length_m * (factor ?? 1))}
        <span>{factor === null ? "long" : `walking cost · ${formatLength(edge.length_m)} long`}</span>
      </div>
      {factor !== null && <Breakdown rows={breakdown(edge, cost)} />}
      <a
        className="link subtle small"
        href={`https://www.openstreetmap.org/way/${edge.way_osm_id}`}
        target="_blank"
        rel="noreferrer"
      >
        View on OpenStreetMap ↗
      </a>
    </>
  );
}

/** What each factor adds or takes off. In this order the parts sum exactly to the
 *  cost (length + heat − shade − fountains + slope); a factor that is off shows
 *  what it would change if it were switched on. */
function breakdown(e: EdgeSummary, cost: CostContext): BreakdownRow[] {
  const { trees: T, fountains: F, slope: S } = cost.factors;
  const c = (trees: boolean, fountains: boolean, slope: boolean) =>
    e.length_m * (perMetre(e, cost, { trees, fountains, slope }) ?? 1);
  const trees = e.tree_count ?? 0;
  return [
    {
      Icon: SunIcon,
      label: "Heat",
      detail: e.pet_mean_c === null ? "PET estimated from neighbours" : `${Math.round(e.pet_mean_c)} °C PET`,
      value: c(false, false, false) - e.length_m,
      on: true,
    },
    {
      Icon: TreeIcon,
      label: "Tree shade",
      detail:
        e.shade_share === null
          ? "no data"
          : `${Math.round(e.shade_share * 100)} % shaded · ${trees} ${trees === 1 ? "tree" : "trees"}`,
      value: T ? c(true, false, false) - c(false, false, false) : c(true, F, S) - c(false, F, S),
      on: T,
    },
    {
      Icon: DropIcon,
      label: "Fountain",
      detail:
        e.nearest_fountain_m === null
          ? "no data"
          : `${formatLength(e.nearest_fountain_m)} away${e.nearest_fountain ? ` · ${e.nearest_fountain}` : ""}`,
      value: F ? c(T, true, false) - c(T, false, false) : c(T, true, S) - c(T, false, S),
      on: F,
    },
    {
      Icon: SlopeIcon,
      label: "Slope",
      detail: e.grade_mean === null || e.grade_max === null ? "no data" : formatGrade(e.grade_mean, e.grade_max),
      value: c(T, F, true) - c(T, F, false),
      on: S,
    },
  ];
}

interface BreakdownRow {
  Icon: () => React.JSX.Element;
  label: string;
  detail: string;
  value: number;
  on: boolean;
}

function Breakdown({ rows }: { rows: BreakdownRow[] }) {
  return (
    <>
      <p className="section-label">Why it costs what it does</p>
      <ul className="breakdown">
        {rows.map(({ Icon, label, detail, value, on }) => (
          <li key={label} className={on ? undefined : "off"}>
            <span className="breakdown-icon">
              <Icon />
            </span>
            <span className="breakdown-text">
              <span className="breakdown-label">{label}</span>
              <span className="breakdown-detail">{detail}</span>
            </span>
            <span className="breakdown-value">{on ? signed(value) : `off (${signed(value)})`}</span>
          </li>
        ))}
      </ul>
    </>
  );
}

function NodeCard({
  node,
  cost,
  onSelect,
}: {
  node: NodeDetail;
  cost: CostContext;
  onSelect: Props["onSelect"];
}) {
  const title =
    node.street_names.length > 0
      ? node.street_names.join(" · ")
      : node.node_type === "dead_end"
        ? "Dead end"
        : "Unnamed intersection";
  const typeLabel = { intersection: "Intersection", junction: "Junction", dead_end: "Dead end" }[
    node.node_type
  ];
  return (
    <>
      <p className="eyebrow">{typeLabel}</p>
      <h3>{title}</h3>
      <p className="section-label">
        {node.degree} connecting {node.degree === 1 ? "street" : "streets"}
      </p>
      <ul className="list">
        {node.edges.map((e) => {
          const factor = perMetre(e, cost, cost.factors);
          return (
            <li key={e.id}>
              <button onClick={() => onSelect({ kind: "edge", id: e.id })}>
                <span className="list-label">{e.street_name ?? formatHighway(e.highway)}</span>
                {factor !== null && <Rating factor={factor} cost={cost} />}
                <span className="list-value">{formatLength(e.length_m * (factor ?? 1))}</span>
                <ChevronIcon />
              </button>
            </li>
          );
        })}
      </ul>
      <a className="link subtle small" href={`https://www.openstreetmap.org/node/${node.id}`} target="_blank" rel="noreferrer">
        View on OpenStreetMap ↗
      </a>
    </>
  );
}
