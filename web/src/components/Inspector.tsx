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
import { categoryOf } from "../map/style";
import {
  formatFountain,
  formatGrade,
  formatHeatRatio,
  formatHighway,
  formatLength,
  formatPet,
  formatTrees,
} from "../format";
import type { HeatProfile } from "../profiles";
import type { Selection } from "./MapView";
import { ChevronIcon, CloseIcon } from "./Icons";

interface Props {
  selection: NonNullable<Selection>;
  meta: GraphMeta;
  profile: HeatProfile;
  factors: Factors;
  onSelect: (s: Selection, focus?: boolean) => void;
  onNodeLoaded: (node: NodeDetail) => void;
}

type Loaded =
  | { kind: "node"; data: NodeDetail }
  | { kind: "edge"; data: EdgeSummary }
  | { kind: "error"; message: string };

export function Inspector({ selection, meta, profile, factors, onSelect, onNodeLoaded }: Props) {
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
        <EdgeCard
          edge={current.data}
          model={meta.cost_model}
          profile={profile}
          factors={factors}
          onSelect={onSelect}
        />
      ) : (
        <NodeCard node={current.data} onSelect={onSelect} />
      )}
    </section>
  );
}

function Chip({ highway }: { highway: string }) {
  return <span className="chip">{formatHighway(highway)}</span>;
}

function EdgeCard({
  edge,
  model,
  profile,
  factors,
  onSelect,
}: {
  edge: EdgeSummary;
  model: CostModel | null;
  profile: HeatProfile;
  factors: Factors;
  onSelect: Props["onSelect"];
}) {
  const factor =
    model && edge.heat_excess_sq_mean !== null
      ? costFactor(
          model,
          profile,
          factors,
          edge.heat_excess_sq_mean,
          edge.shade_share,
          edge.fountain_share,
          edge.slope_excess,
        )
      : null;
  return (
    <>
      <p className="eyebrow">Edge</p>
      <h3>{edge.street_name ?? categoryOf(edge.highway).label}</h3>
      <div className="chips">
        <Chip highway={edge.highway} />
        {edge.component !== 0 && <span className="chip muted">Disconnected</span>}
      </div>
      <div className="big-number">
        {formatLength(edge.length_m * (factor ?? 1))}
        <span>cost</span>
      </div>
      <p className="subtle small">
        {formatLength(edge.length_m)} long
        {formatPet(edge.pet_mean_c) ? ` · ${formatPet(edge.pet_mean_c)}` : ""}
        {model && factor !== null ? ` · ${formatHeatRatio(factor, referenceMedian(model, profile))}` : ""}
      </p>
      {edge.shade_share !== null && edge.tree_count !== null && (
        <p className="subtle small">{formatTrees(edge.tree_count, edge.shade_share)}</p>
      )}
      {edge.nearest_fountain_m !== null && (
        <p className="subtle small">{formatFountain(edge.nearest_fountain, edge.nearest_fountain_m)}</p>
      )}
      {edge.grade_mean !== null && edge.grade_max !== null && (
        <p className="subtle small">{formatGrade(edge.grade_mean, edge.grade_max)}</p>
      )}
      <ul className="list">
        {(
          [
            ["From", edge.source],
            ["To", edge.target],
          ] as const
        ).map(([label, id]) => (
          <li key={label}>
            <button onClick={() => onSelect({ kind: "node", id }, true)}>
              <span className="list-label">{label}</span>
              <span className="list-value mono">Node {id}</span>
              <ChevronIcon />
            </button>
          </li>
        ))}
      </ul>
      <a
        className="link"
        href={`https://www.openstreetmap.org/way/${edge.way_osm_id}`}
        target="_blank"
        rel="noreferrer"
      >
        View way {edge.way_osm_id} on OpenStreetMap
      </a>
    </>
  );
}

function NodeCard({
  node,
  onSelect,
}: {
  node: NodeDetail;
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
      <p className="subtle small mono">
        {node.lat.toFixed(5)}° N, {node.lon.toFixed(5)}° E
      </p>
      <p className="section-label">
        {node.degree} connecting {node.degree === 1 ? "edge" : "edges"}
      </p>
      <ul className="list">
        {node.edges.map((e) => (
          <li key={e.id}>
            <button onClick={() => onSelect({ kind: "edge", id: e.id })}>
              <span className="list-label">{e.street_name ?? formatHighway(e.highway)}</span>
              <span className="list-value">{formatLength(e.length_m)}</span>
              <ChevronIcon />
            </button>
          </li>
        ))}
      </ul>
      <a
        className="link"
        href={`https://www.openstreetmap.org/node/${node.id}`}
        target="_blank"
        rel="noreferrer"
      >
        View node {node.id} on OpenStreetMap
      </a>
    </>
  );
}
