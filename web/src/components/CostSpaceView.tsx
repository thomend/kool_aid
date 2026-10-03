// The cost-space view: the graph laid out so that on-screen edge length equals
// cost, drawn with deck.gl on a plain canvas in metres. `t` morphs every vertex
// between its geographic (0) and cost-space (1) position.

import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import DeckGL, { type DeckGLRef } from "@deck.gl/react";
import { LinearInterpolator, OrthographicView, type PickingInfo } from "@deck.gl/core";
import { PathLayer, ScatterplotLayer, TextLayer } from "@deck.gl/layers";
import type { CostSpaceData, GraphMeta } from "../api";
import type { Scheme } from "../map/basemap";
import { ACCENT, NO_DATA, categoryOf } from "../map/style";
import { heatFactor, referenceMedian } from "../costModel";
import { STREET_WIDTH_RATIO, edgeColorFn, edgeWidthAtZoom, hexToRgba } from "../colors";
import { deckZoomToMap, lv95ToWgs84, mapZoomToDeck, wgs84ToLv95 } from "../geo";
import { formatHeatRatio, formatHighway, formatLength, formatPet } from "../format";
import type { Selection } from "./MapView";

export interface CostSpaceHandle {
  zoomIn(): void;
  zoomOut(): void;
  fitAll(): void;
  /** Center on a geographic point (its position at the current morph state). */
  focus(lon: number, lat: number, mapZoom?: number): void;
  /** Camera in map terms, for handing over to/from the geographic view. */
  getCamera(): { center: [number, number]; mapZoom: number };
  setCamera(center: [number, number], mapZoom: number): void;
}

interface Props {
  data: CostSpaceData;
  meta: GraphMeta;
  scheme: Scheme;
  t: number;
  selection: Selection;
  onSelect: (s: Selection) => void;
}

interface ViewState {
  target: [number, number, number];
  zoom: number;
  transitionDuration?: number;
  transitionInterpolator?: LinearInterpolator;
}

const VIEW = new OrthographicView({ id: "cost", flipY: false });
const MIN_ZOOM = mapZoomToDeck(11);
const MAX_ZOOM = mapZoomToDeck(19.5);
const NODE_MIN_MAP_ZOOM = 14.5;
const INTERPOLATOR = new LinearInterpolator(["target", "zoom"]);
// Must keep its identity across renders (a new object makes deck.gl rebuild
// its gesture recognizers). Clicks are detected by us, see onPointerUp below,
// because deck.gl 9.4's tap recognizer drops them (dblclick and click require
// each other's failure, and any pointer input in the 300 ms wait cancels it).
const CONTROLLER = {
  dragRotate: false,
  doubleClickZoom: false,
  scrollZoom: { smooth: true, speed: 0.02 },
};

const PALETTE = {
  light: {
    water: "#a9d2f3",
    label: "#6e6e73",
    halo: "#f4f2ee",
    surface: "#ffffff",
    stroke: "#3a3a3c",
    grid: [60, 60, 67, 46],
  },
  dark: {
    water: "#22384f",
    label: "#8e8e93",
    halo: "#1b1c1f",
    surface: "#2c2c2e",
    stroke: "#d1d1d6",
    grid: [235, 235, 245, 40],
  },
} as const;

const RIVER_WIDTH_M: Record<string, number> = { Rhein: 190, Wiese: 25, Birs: 30, Birsig: 8 };

function lerp(geo: Float32Array, delta: Float32Array, t: number, out: Float32Array) {
  for (let i = 0; i < geo.length; i++) out[i] = geo[i] + delta[i] * t;
  return out;
}

function prepare(geo: number[], cost: number[]) {
  const g = Float32Array.from(geo);
  const d = new Float32Array(g.length);
  for (let i = 0; i < g.length; i++) d[i] = cost[i] - g[i];
  return { geo: g, delta: d };
}

type Prepared = ReturnType<typeof prepareData>;

function prepareData(data: CostSpaceData) {
  const e = data.edges;
  const visibleNodes = data.nodes.node_type
    .map((type, i) => (type === "junction" ? -1 : i))
    .filter((i) => i >= 0);
  const nodeGeo: number[] = [];
  const nodeCost: number[] = [];
  for (const i of visibleNodes) {
    nodeGeo.push(data.nodes.geo[2 * i], data.nodes.geo[2 * i + 1]);
    nodeCost.push(data.nodes.cost[2 * i], data.nodes.cost[2 * i + 1]);
  }
  const nodeIndex = new Map(data.nodes.ids.map((id, i) => [id, i]));
  const edgeIndex = new Map(e.ids.map((id, i) => [id, i]));
  const starts = Uint32Array.from([...e.start_indices, e.geo.length / 2]);
  return {
    edges: prepare(e.geo, e.cost),
    starts,
    nodes: prepare(nodeGeo, nodeCost),
    allNodes: prepare(data.nodes.geo, data.nodes.cost),
    visibleNodes,
    nodeIndex,
    edgeIndex,
    rivers: data.context.lines.map((l) => ({ name: l.name, ...prepare(l.geo, l.cost) })),
    labels: data.context.labels.map((l) => ({ name: l.name, kind: l.kind, ...prepare(l.geo, l.cost) })),
    grid: data.context.grid.map((l) => prepare(l.geo, l.cost)),
  };
}

// Cost-space positions part way (k) from one heat profile's layout to
// another's. All profiles share the same geometry, only the deltas differ.
function blendPrepared(from: Prepared, to: Prepared, k: number): Prepared {
  const mix = <T extends { geo: Float32Array; delta: Float32Array }>(a: T, b: T): T => {
    const delta = new Float32Array(b.delta.length);
    for (let i = 0; i < delta.length; i++) delta[i] = a.delta[i] + (b.delta[i] - a.delta[i]) * k;
    return { ...b, delta };
  };
  return {
    ...to,
    edges: mix(from.edges, to.edges),
    nodes: mix(from.nodes, to.nodes),
    allNodes: mix(from.allNodes, to.allNodes),
    rivers: to.rivers.map((r, i) => mix(from.rivers[i], r)),
    labels: to.labels.map((l, i) => mix(from.labels[i], l)),
    grid: to.grid.map((l, i) => mix(from.grid[i], l)),
  };
}

function sameShape(a: Prepared, b: Prepared) {
  return (
    a.edges.delta.length === b.edges.delta.length &&
    a.allNodes.delta.length === b.allNodes.delta.length &&
    a.nodes.delta.length === b.nodes.delta.length &&
    a.rivers.length === b.rivers.length &&
    a.labels.length === b.labels.length &&
    a.grid.length === b.grid.length &&
    a.grid.every((l, i) => l.delta.length === b.grid[i].delta.length)
  );
}

const PROFILE_TRANSITION_MS = 900;
const easeInOutCubic = (k: number) => (k < 0.5 ? 4 * k ** 3 : 1 - (-2 * k + 2) ** 3 / 2);

export const CostSpaceView = forwardRef<CostSpaceHandle, Props>(function CostSpaceView(
  { data, meta, scheme, t, selection, onSelect },
  ref,
) {
  const container = useRef<HTMLDivElement>(null);
  const deckRef = useRef<DeckGLRef>(null);
  const pressed = useRef<{ x: number; y: number; time: number } | null>(null);
  const [viewState, setViewState] = useState<ViewState>(() => ({ target: [0, 0, 0], zoom: -3 }));
  const [hover, setHover] = useState<{ x: number; y: number; title: string; detail: string } | null>(
    null,
  );

  // ---------- static per-dataset arrays ----------
  const target = useMemo(() => prepareData(data), [data]);

  // A new dataset (another heat profile) is blended in from what was on screen
  const shown = useRef<Prepared | null>(null);
  const [transition, setTransition] = useState<{ to: Prepared; from: Prepared | null; k: number }>(
    () => ({ to: target, from: null, k: 1 }),
  );
  if (transition.to !== target) {
    const from = shown.current && sameShape(shown.current, target) ? shown.current : null;
    setTransition({ to: target, from, k: from ? 0 : 1 });
  }
  useEffect(() => {
    if (!transition.from || transition.k > 0) return;
    let frame = 0;
    const start = performance.now();
    const step = (now: number) => {
      const k = Math.min(1, (now - start) / PROFILE_TRANSITION_MS);
      setTransition((tr) => ({ ...tr, k: easeInOutCubic(k) }));
      if (k < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transition.to]);
  const prepared = useMemo(
    () =>
      transition.from && transition.k < 1
        ? blendPrepared(transition.from, transition.to, transition.k)
        : transition.to,
    [transition],
  );
  shown.current = prepared;

  // ---------- positions at the current morph state ----------
  const edgePositions = useMemo(
    () => lerp(prepared.edges.geo, prepared.edges.delta, t, new Float32Array(prepared.edges.geo.length)),
    [prepared, t],
  );
  const nodePositions = useMemo(
    () => lerp(prepared.nodes.geo, prepared.nodes.delta, t, new Float32Array(prepared.nodes.geo.length)),
    [prepared, t],
  );

  const positionOfNode = (nodeId: number): [number, number] | null => {
    const i = prepared.nodeIndex.get(nodeId);
    if (i === undefined) return null;
    const { geo, delta } = prepared.allNodes;
    return [geo[2 * i] + delta[2 * i] * t, geo[2 * i + 1] + delta[2 * i + 1] * t];
  };

  // ---------- camera ----------
  const [ox, oy] = data.origin_lv95;
  const toLocal = (lon: number, lat: number): [number, number] => {
    const [e, n] = wgs84ToLv95(lon, lat);
    return [e - ox, n - oy];
  };

  const animateTo = (target: [number, number], zoom: number, duration = 500) =>
    setViewState({
      target: [target[0], target[1], 0],
      zoom: Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom)),
      transitionDuration: duration,
      transitionInterpolator: INTERPOLATOR,
    });

  const fitZoom = () => {
    const el = container.current;
    const b = data.bounds;
    if (!el) return -3;
    const pad = 80;
    return Math.log2(
      Math.min((el.clientWidth - pad) / (b.max_x - b.min_x), (el.clientHeight - pad) / (b.max_y - b.min_y)),
    );
  };

  useImperativeHandle(ref, () => ({
    zoomIn: () => animateTo([viewState.target[0], viewState.target[1]], viewState.zoom + 1, 300),
    zoomOut: () => animateTo([viewState.target[0], viewState.target[1]], viewState.zoom - 1, 300),
    fitAll: () => {
      const b = data.bounds;
      animateTo([(b.min_x + b.max_x) / 2, (b.min_y + b.max_y) / 2], fitZoom(), 900);
    },
    focus: (lon, lat, mapZoom) => {
      const [x, y] = toLocal(lon, lat);
      const nodeShift = nearestShift(x, y);
      const zoom = mapZoom === undefined ? viewState.zoom : mapZoomToDeck(mapZoom);
      animateTo([x + nodeShift[0] * t, y + nodeShift[1] * t], zoom, 800);
    },
    getCamera: () => {
      const [lon, lat] = lv95ToWgs84(viewState.target[0] + ox, viewState.target[1] + oy);
      return { center: [lon, lat], mapZoom: deckZoomToMap(viewState.zoom) };
    },
    setCamera: ([lon, lat], mapZoom) => {
      const [x, y] = toLocal(lon, lat);
      setViewState({ target: [x, y, 0], zoom: mapZoomToDeck(mapZoom) });
    },
  }));

  // Displacement of the node closest to a local point (for focusing in cost space)
  const nearestShift = (x: number, y: number): [number, number] => {
    const { geo, delta } = prepared.allNodes;
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < geo.length; i += 2) {
      const d = (geo[i] - x) ** 2 + (geo[i + 1] - y) ** 2;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return [delta[best], delta[best + 1]];
  };

  // ---------- styling ----------
  const mapZoom = deckZoomToMap(viewState.zoom);
  const palette = PALETTE[scheme];
  const accent = hexToRgba(ACCENT[scheme]);

  // Heat factors of the profile and relief this layout was built for
  const { profile, trees, fountains } = data.meta;
  const model = meta.cost_model;
  const factors = useMemo(() => {
    const e = data.edges;
    if (!model) return e.ids.map(() => 1);
    const relief = { trees, fountains };
    return e.ids.map((_, i) =>
      heatFactor(model, profile, relief, e.heat_excess_sq_mean[i], e.shade_share[i], e.fountain_share[i]),
    );
  }, [data, model, profile, trees, fountains]);
  const edgeColors = useMemo(() => {
    if (!model) return factors.map(() => hexToRgba(NO_DATA[scheme]));
    const color = edgeColorFn(model, scheme, profile);
    return factors.map((f) => color(f));
  }, [factors, model, scheme, profile]);

  const nodeOpacity = Math.min(1, Math.max(0, (mapZoom - NODE_MIN_MAP_ZOOM) / 0.7));
  const nodeRadius = (intersection: boolean) => {
    const k = Math.min(1, Math.max(0, (mapZoom - NODE_MIN_MAP_ZOOM) / (18 - NODE_MIN_MAP_ZOOM)));
    return intersection ? 1.6 + (4.5 - 1.6) * k : 1.3 + (3.5 - 1.3) * k;
  };

  // ---------- layers ----------
  const selectedEdge = selection?.kind === "edge" ? prepared.edgeIndex.get(selection.id) : undefined;
  const selectedPath =
    selectedEdge === undefined
      ? null
      : edgePositions.subarray(prepared.starts[selectedEdge] * 2, prepared.starts[selectedEdge + 1] * 2);
  const selectedNode = selection?.kind === "node" ? positionOfNode(selection.id) : null;

  const layers = [
    // Regular grid, warped like the network: stretched cells are hotter than
    // typical, squeezed cells cooler
    new PathLayer({
      id: "grid",
      data: prepared.grid.map((l) => lerp(l.geo, l.delta, t, new Float32Array(l.geo.length))),
      getPath: (d) => d,
      positionFormat: "XY",
      getColor: palette.grid as unknown as [number, number, number, number],
      getWidth: 1,
      widthUnits: "pixels",
      updateTriggers: { getColor: scheme },
    }),
    new PathLayer({
      id: "rivers",
      data: prepared.rivers.map((r) => ({
        name: r.name,
        path: lerp(r.geo, r.delta, t, new Float32Array(r.geo.length)),
      })),
      getPath: (d) => d.path,
      positionFormat: "XY",
      getColor: hexToRgba(palette.water),
      getWidth: (d) => RIVER_WIDTH_M[d.name] ?? 20,
      widthUnits: "common",
      widthMinPixels: 1,
      capRounded: true,
      jointRounded: true,
      updateTriggers: { getColor: scheme },
    }),
    new PathLayer({
      id: "edges",
      data: {
        length: data.edges.ids.length,
        startIndices: prepared.starts,
        attributes: { getPath: { value: edgePositions, size: 2 } },
      },
      _pathType: "open",
      positionFormat: "XY",
      getColor: (_: unknown, { index }: { index: number }) => edgeColors[index],
      getWidth: (_: unknown, { index }: { index: number }) =>
        data.edges.is_pedestrian[index] ? 1 : STREET_WIDTH_RATIO,
      widthUnits: "pixels",
      widthScale: edgeWidthAtZoom(mapZoom),
      capRounded: true,
      jointRounded: true,
      pickable: true,
      autoHighlight: true,
      highlightColor: [accent[0], accent[1], accent[2], 255],
      updateTriggers: { getColor: [scheme, edgeColors] },
    }),
    selectedPath &&
      new PathLayer({
        id: "selected-edge",
        data: [{ path: selectedPath }],
        getPath: (d) => d.path,
        positionFormat: "XY",
        getColor: accent,
        getWidth: 1,
        widthUnits: "pixels",
        widthScale: edgeWidthAtZoom(mapZoom) * 1.8,
        widthMinPixels: 3,
        capRounded: true,
        jointRounded: true,
      }),
    new ScatterplotLayer({
      id: "nodes",
      data: {
        length: prepared.visibleNodes.length,
        attributes: { getPosition: { value: nodePositions, size: 2 } },
      },
      visible: nodeOpacity > 0,
      opacity: nodeOpacity,
      radiusUnits: "pixels",
      getRadius: (_: unknown, { index }: { index: number }) =>
        nodeRadius(data.nodes.node_type[prepared.visibleNodes[index]] === "intersection"),
      getFillColor: (_: unknown, { index }: { index: number }) =>
        hexToRgba(
          data.nodes.node_type[prepared.visibleNodes[index]] === "dead_end" ? palette.stroke : palette.surface,
        ),
      getLineColor: hexToRgba(palette.stroke),
      stroked: true,
      lineWidthUnits: "pixels",
      getLineWidth: mapZoom > 17 ? 1.5 : 0.8,
      pickable: true,
      updateTriggers: { getRadius: Math.round(mapZoom * 4), getFillColor: scheme, getLineColor: scheme },
    }),
    selectedNode &&
      new ScatterplotLayer({
        id: "selected-node",
        data: [selectedNode],
        getPosition: (d) => d,
        radiusUnits: "pixels",
        getRadius: mapZoom > 16 ? 8 : 5.5,
        getFillColor: accent,
        getLineColor: hexToRgba(palette.surface),
        stroked: true,
        lineWidthUnits: "pixels",
        getLineWidth: 2.5,
      }),
    new TextLayer({
      id: "district-labels",
      data: visibleLabels(
        prepared.labels.map((l) => ({
          name: l.name.toUpperCase(),
          kind: l.kind,
          position: [l.geo[0] + l.delta[0] * t, l.geo[1] + l.delta[1] * t] as [number, number],
        })),
        viewState.zoom,
      ),
      getText: (d) => d.name,
      getPosition: (d) => d.position,
      getSize: 11,
      getColor: hexToRgba(palette.label),
      fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", Inter, sans-serif',
      fontWeight: 700,
      characterSet: "auto",
      fontSettings: { sdf: true },
      outlineWidth: 4,
      outlineColor: hexToRgba(palette.halo, 230),
      getTextAnchor: "middle",
      getAlignmentBaseline: "center",
      // wrap long names ("ALTSTADT KLEINBASEL") onto two lines
      maxWidth: 9,
      wordBreak: "break-word",
      lineHeight: 1.15,
      visible: mapZoom < 16.5,
      updateTriggers: { getColor: scheme },
    }),
  ];

  const onHover = (info: PickingInfo) => {
    if (!info.picked) return setHover(null);
    if (info.layer?.id === "edges") {
      const i = info.index;
      const pet = formatPet(data.edges.pet_mean_c[i]);
      setHover({
        x: info.x,
        y: info.y,
        title: data.edges.street_name[i] ?? categoryOf(data.edges.highway[i]).label,
        detail: [
          formatLength(data.edges.length_m[i] * factors[i]) + " cost",
          ...(model ? [formatHeatRatio(factors[i], referenceMedian(model, profile))] : []),
          formatHighway(data.edges.highway[i]).toLowerCase(),
          ...(pet ? [pet] : []),
        ].join(" · "),
      });
    } else if (info.layer?.id === "nodes") {
      const i = prepared.visibleNodes[info.index];
      const degree = data.nodes.degree[i];
      setHover({
        x: info.x,
        y: info.y,
        title: data.nodes.node_type[i] === "dead_end" ? "Dead end" : "Intersection",
        detail: `${degree} connecting ${degree === 1 ? "edge" : "edges"}`,
      });
    } else setHover(null);
  };

  const select = (info: PickingInfo | null) => {
    if (info?.layer?.id === "nodes") {
      onSelect({ kind: "node", id: data.nodes.ids[prepared.visibleNodes[info.index]] });
    } else if (info?.layer?.id === "edges") {
      onSelect({ kind: "edge", id: data.edges.ids[info.index] });
    } else onSelect(null);
  };

  // A click is a short press that barely moved (anything else was a pan)
  const onPointerDown = (e: React.PointerEvent) => {
    pressed.current = { x: e.clientX, y: e.clientY, time: e.timeStamp };
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const down = pressed.current;
    pressed.current = null;
    if (!down || e.button !== 0) return;
    const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
    if (moved > 5 || e.timeStamp - down.time > 500) return;
    const rect = container.current!.getBoundingClientRect();
    const info = deckRef.current?.pickObject({
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
      radius: 5,
      layerIds: ["nodes", "edges"],
    });
    select(info ?? null);
  };

  useEffect(() => setHover(null), [t]);

  return (
    <div
      ref={container}
      className="cost-space"
      onMouseLeave={() => setHover(null)}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
    >
      <DeckGL
        ref={deckRef}
        views={VIEW}
        viewState={viewState}
        onViewStateChange={({ viewState: v }) => {
          const next = v as ViewState;
          setViewState({ ...next, zoom: Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next.zoom)) });
          setHover(null);
        }}
        controller={CONTROLLER}
        layers={layers}
        pickingRadius={5}
        onHover={onHover}
        getCursor={({ isDragging, isHovering }) =>
          isDragging ? "grabbing" : isHovering ? "pointer" : "grab"
        }
      />
      {hover && (
        <div className="tooltip glass" style={{ left: hover.x, top: hover.y }}>
          <div className="tooltip-title">{hover.title}</div>
          <div className="tooltip-detail">{hover.detail}</div>
        </div>
      )}
      <ScaleBar zoom={viewState.zoom} />
    </div>
  );
});

// Greedy label placement: drop labels whose screen box would overlap one
// already placed (suburbs first, then smaller quarters).
const LABEL_SIZE = 11;
const LABEL_WRAP_CHARS = 13;

function visibleLabels<T extends { name: string; kind: string; position: [number, number] }>(
  labels: T[],
  zoom: number,
): T[] {
  const scale = Math.pow(2, zoom);
  const placed: { x0: number; x1: number; y0: number; y1: number }[] = [];
  const ordered = [...labels].sort((a, b) => Number(a.kind !== "suburb") - Number(b.kind !== "suburb"));
  return ordered.filter((label) => {
    const wraps = label.name.length > LABEL_WRAP_CHARS;
    const chars = wraps ? Math.max(...label.name.split(" ").map((w) => w.length)) : label.name.length;
    const w = chars * LABEL_SIZE * 0.72 + 8;
    const h = (wraps ? 2.3 : 1.2) * LABEL_SIZE + 6;
    const x = label.position[0] * scale;
    const y = label.position[1] * scale;
    const box = { x0: x - w / 2, x1: x + w / 2, y0: y - h / 2, y1: y + h / 2 };
    if (placed.some((p) => box.x0 < p.x1 && box.x1 > p.x0 && box.y0 < p.y1 && box.y1 > p.y0)) {
      return false;
    }
    placed.push(box);
    return true;
  });
}

function ScaleBar({ zoom }: { zoom: number }) {
  const pxPerMetre = Math.pow(2, zoom);
  const candidates = [5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000];
  const metres = candidates.find((m) => m * pxPerMetre >= 70) ?? 5000;
  return (
    <div className="scale-bar glass" aria-label={`Scale: ${formatLength(metres)} of walking at typical heat`}>
      <span className="scale-line" style={{ width: metres * pxPerMetre }} />
      <span>{formatLength(metres)} at typical heat</span>
    </div>
  );
}
