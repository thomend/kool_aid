import { useEffect, useState } from "react";
import { fetchEdge, fetchNode, type EdgeSummary, type NodeDetail } from "../api";
import type { Scheme } from "../map/basemap";
import { categoryOf } from "../map/style";
import { formatHighway, formatLength } from "../format";
import type { Selection } from "./MapView";
import { ChevronIcon, CloseIcon } from "./Icons";

interface Props {
  selection: NonNullable<Selection>;
  scheme: Scheme;
  onSelect: (s: Selection, focus?: boolean) => void;
  onNodeLoaded: (node: NodeDetail) => void;
}

type Loaded =
  | { kind: "node"; data: NodeDetail }
  | { kind: "edge"; data: EdgeSummary }
  | { kind: "error"; message: string };

export function Inspector({ selection, scheme, onSelect, onNodeLoaded }: Props) {
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
        <EdgeCard edge={current.data} scheme={scheme} onSelect={onSelect} />
      ) : (
        <NodeCard node={current.data} scheme={scheme} onSelect={onSelect} />
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
  onSelect,
}: {
  edge: EdgeSummary;
  scheme: Scheme;
  onSelect: Props["onSelect"];
}) {
  return (
    <>
      <p className="eyebrow">Edge</p>
      <h3>{edge.street_name ?? categoryOf(edge.highway).label}</h3>
      <div className="chips">
        <Chip highway={edge.highway} scheme={scheme} />
        {edge.component !== 0 && <span className="chip muted">Disconnected</span>}
      </div>
      <div className="big-number">
        {formatLength(edge.length_m)}
        <span>cost</span>
      </div>
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
  onSelect,
}: {
  node: NodeDetail;
  scheme: Scheme;
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
