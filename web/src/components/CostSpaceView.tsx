// The cost-space view: the graph laid out so that on-screen edge length equals
// cost, drawn with deck.gl on a plain canvas in metres. Node positions come
// live from the layout worker (costLayout.ts); `t` morphs every vertex between
// its geographic (0) and cost-space (1) position.

import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import DeckGL, { type DeckGLRef } from "@deck.gl/react";
import { LinearInterpolator, OrthographicView, type PickingInfo } from "@deck.gl/core";
import { PathLayer, ScatterplotLayer, TextLayer } from "@deck.gl/layers";
import type { CostSpaceData } from "../api";
import type { EdgeCosts } from "../cost";
import { buildGeometry, costPositions } from "../costLayout";
import type { Scheme } from "../map/basemap";
import { ACCENT, categoryOf, type ColorMode } from "../map/style";
import { STREET_WIDTH_RATIO, edgeColorFn, edgeWidthAtZoom, hexToRgba } from "../colors";
import { deckZoomToMap, lv95ToWgs84, mapZoomToDeck, wgs84ToLv95 } from "../geo";
import { formatLength } from "../format";
import { edgeDetail, type Selection } from "./MapView";

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
  costs: EdgeCosts;
  /** Cost-space node positions, aligned with data.nodes (live layout). */
  positions: Float64Array;
  /** Layout length = cost × costScale, for the scale bar. */
  costScale: number;
  scheme: Scheme;
  mode: ColorMode;
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
  light: { water: "#a9d2f3", label: "#6e6e73", halo: "#f4f2ee", surface: "#ffffff", stroke: "#3a3a3c" },
  dark: { water: "#22384f", label: "#8e8e93", halo: "#1b1c1f", surface: "#2c2c2e", stroke: "#d1d1d6" },
} as const;

const RIVER_WIDTH_M: Record<string, number> = { Rhein: 190, Wiese: 25, Birs: 30, Birsig: 8 };

/** geo + t · (cost − geo), element-wise */
function lerp(geo: ArrayLike<number>, cost: ArrayLike<number>, t: number) {
  const out = new Float32Array(geo.length);
  for (let i = 0; i < geo.length; i++) out[i] = geo[i] + (cost[i] - geo[i]) * t;
  return out;
}

export const CostSpaceView = forwardRef<CostSpaceHandle, Props>(function CostSpaceView(
  { data, costs, positions, costScale, scheme, mode, t, selection, onSelect },
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
  const geometry = useMemo(() => buildGeometry(data), [data]);
  const prepared = useMemo(() => {
    const visibleNodes = data.nodes.node_type
      .map((type, i) => (type === "junction" ? -1 : i))
      .filter((i) => i >= 0);
    return {
      visibleNodes,
      nodeIndex: new Map(data.nodes.ids.map((id, i) => [id, i])),
      edgeIndex: new Map(data.edges.ids.map((id, i) => [id, i])),
    };
  }, [data]);

  // ---------- cost-space positions from the live layout ----------
  const cost = useMemo(() => costPositions(geometry, positions), [geometry, positions]);

  // ---------- positions at the current morph state ----------
  const edgePositions = useMemo(() => lerp(geometry.edgeGeo, cost.edges, t), [geometry, cost, t]);
  const nodePositions = useMemo(() => {
    const out = new Float32Array(prepared.visibleNodes.length * 2);
    prepared.visibleNodes.forEach((i, k) => {
      out[2 * k] = geometry.nodeGeo[2 * i] + (cost.nodes[2 * i] - geometry.nodeGeo[2 * i]) * t;
      out[2 * k + 1] = geometry.nodeGeo[2 * i + 1] + (cost.nodes[2 * i + 1] - geometry.nodeGeo[2 * i + 1]) * t;
    });
    return out;
  }, [geometry, cost, prepared, t]);

  const positionOfNode = (nodeId: number): [number, number] | null => {
    const i = prepared.nodeIndex.get(nodeId);
    if (i === undefined) return null;
    const g = geometry.nodeGeo;
    return [g[2 * i] + (cost.nodes[2 * i] - g[2 * i]) * t, g[2 * i + 1] + (cost.nodes[2 * i + 1] - g[2 * i + 1]) * t];
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
    const geo = geometry.nodeGeo;
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < geo.length; i += 2) {
      const d = (geo[i] - x) ** 2 + (geo[i + 1] - y) ** 2;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return [cost.nodes[best] - geo[best], cost.nodes[best + 1] - geo[best + 1]];
  };

  // ---------- styling ----------
  const mapZoom = deckZoomToMap(viewState.zoom);
  const palette = PALETTE[scheme];
  const accent = hexToRgba(ACCENT[scheme]);

  const edgeColors = useMemo(() => {
    const color = edgeColorFn(mode, scheme);
    return data.edges.highway.map((h, i) => {
      const id = data.edges.ids[i];
      return color(h, costs.get(id) ?? data.edges.length_m[i], costs.perMetreOf(id) ?? 1);
    });
  }, [data, costs, mode, scheme]);

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
      : edgePositions.subarray(geometry.starts[selectedEdge] * 2, geometry.starts[selectedEdge + 1] * 2);
  const selectedNode = selection?.kind === "node" ? positionOfNode(selection.id) : null;

  const layers = [
    new PathLayer({
      id: "rivers",
      data: geometry.context.rivers.map((r, k) => ({
        name: r.name,
        path: lerp(r.geo, cost.rivers[k], t),
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
        startIndices: geometry.starts,
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
      updateTriggers: { getColor: [mode, scheme, costs] },
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
        geometry.context.labels.map((l, k) => ({
          name: l.name.toUpperCase(),
          kind: l.kind,
          position: [
            l.geo[0] + (cost.labels[k][0] - l.geo[0]) * t,
            l.geo[1] + (cost.labels[k][1] - l.geo[1]) * t,
          ] as [number, number],
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
      setHover({
        x: info.x,
        y: info.y,
        title: data.edges.street_name[i] ?? categoryOf(data.edges.highway[i]).label,
        detail: edgeDetail(costs, data.edges.ids[i], data.edges.highway[i]),
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
      <ScaleBar zoom={viewState.zoom} costScale={costScale} />
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

// How many pixels one metre of cost takes: zoom gives pixels per layout metre,
// and a metre of cost is costScale layout metres.
function ScaleBar({ zoom, costScale }: { zoom: number; costScale: number }) {
  const pxPerMetre = Math.pow(2, zoom) * costScale;
  const candidates = [5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000];
  const metres = candidates.find((m) => m * pxPerMetre >= 70) ?? 5000;
  return (
    <div className="scale-bar glass" aria-label={`Scale: ${formatLength(metres)} of walking cost`}>
      <span className="scale-line" style={{ width: metres * pxPerMetre }} />
      <span>{formatLength(metres)} of cost</span>
    </div>
  );
}
