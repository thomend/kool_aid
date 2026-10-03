import { useEffect, useState } from "react";
import { fetchEdge, fetchNode, type EdgeSummary, type NodeDetail } from "../api";
import type { EdgeCosts } from "../cost";
import type { Scheme } from "../map/basemap";
import { categoryOf } from "../map/style";
import { formatHighway, formatLength } from "../format";
import type { Selection } from "./MapView";
import { ChevronIcon, CloseIcon } from "./Icons";

interface Props {
  selection: NonNullable<Selection>;
  scheme: Scheme;
  costs: EdgeCosts;
  onSelect: (s: Selection, focus?: boolean) => void;
  onNodeLoaded: (node: NodeDetail) => void;
}

type Loaded =
  | { kind: "node"; data: NodeDetail }
  | { kind: "edge"; data: EdgeSummary }
  | { kind: "error"; message: string };

export function Inspector({ selection, scheme, costs, onSelect, onNodeLoaded }: Props) {
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
        <EdgeCard edge={current.data} scheme={scheme} costs={costs} onSelect={onSelect} />
      ) : (
        <NodeCard node={current.data} scheme={scheme} costs={costs} onSelect={onSelect} />
      )}
    </section>
  );
}

function Chip({ highway, scheme }: { highway: string; scheme: Scheme }) {
  const c = categoryOf(highway);
  return (
    <span className="chip" style={{ "--chip": c.color[scheme] } as React.CSSProperties}>
      {formatHighway(highway)}
    </span>
  );
}

function EdgeCard({
  edge,
  scheme,
  costs,
  onSelect,
}: {
  edge: EdgeSummary;
  scheme: Scheme;
  costs: EdgeCosts;
  onSelect: Props["onSelect"];
}) {
  const b = costs.breakdown(edge.id);
  return (
    <>
      <p className="eyebrow">Edge</p>
      <h3>{edge.street_name ?? categoryOf(edge.highway).label}</h3>
      <div className="chips">
        <Chip highway={edge.highway} scheme={scheme} />
        {edge.component !== 0 && <span className="chip muted">Disconnected</span>}
      </div>
      <div className="big-number">
        {formatLength(b?.cost ?? edge.length_m)}
        <span>cost</span>
      </div>
      {b && <CostBreakdown b={b} />}
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
  scheme,
  costs,
  onSelect,
}: {
  node: NodeDetail;
  scheme: Scheme;
  costs: EdgeCosts;
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
              <span
                className="dot"
                style={{ background: categoryOf(e.highway).color[scheme] }}
                aria-hidden
              />
              <span className="list-label">{e.street_name ?? formatHighway(e.highway)}</span>
              <span className="list-value">{formatLength(costs.get(e.id) ?? e.length_m)}</span>
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

/** One row per active factor with its contribution in metres; they add up to the cost. */
function CostBreakdown({ b }: { b: NonNullable<ReturnType<EdgeCosts["breakdown"]>> }) {
  const floored = b.parts.reduce((sum, p) => sum + p.metres, 0) < b.cost - 1e-6;
  return (
    <table className="breakdown small">
      <tbody>
        {b.parts.map((p) => (
          <tr key={p.factor.key}>
            <td>
              {p.factor.label}
              {p.variantLabel && <span className="subtle"> ({p.variantLabel})</span>}
            </td>
            <td className="subtle">
              {p.factor.transform === "constant"
                ? `${formatLength(b.length)} × ${p.weight.toFixed(2)}`
                : p.value === null
                  ? "no data"
                  : `${p.value.toFixed(1)}${p.factor.key === "heat" ? " °C" : ""}`}
            </td>
            <td>+{formatLength(p.metres)}</td>
          </tr>
        ))}
        <tr className="total">
          <td>Cost</td>
          <td className="subtle">{floored ? "minimum" : `${b.multiplier.toFixed(2)} per m`}</td>
          <td>{formatLength(b.cost)}</td>
        </tr>
      </tbody>
    </table>
  );
}
