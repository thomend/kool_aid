// Live cost-space layout: runs layout.worker.ts whenever the edge costs change
// and turns node positions into everything the cost-space view draws.
//
// Only node positions are computed by the layout. Edges are drawn straight
// between their two nodes (so their drawn length is their cost), with their
// vertices at the same fraction of arc length as in reality, so the morph can
// interpolate vertex by vertex. Rivers and district labels follow the
// inverse-distance-weighted displacement of their nearest nodes.

import { useEffect, useMemo, useRef, useState } from "react";
import type { CostSpaceData } from "./api";
import type { EdgeCosts } from "./cost";
import type { LayoutInit, LayoutProgress, LayoutQuality, LayoutRun } from "./layout.worker";

export type { LayoutQuality };

const IDW_NEIGHBOURS = 8;

export interface LayoutGeometry {
  nodeGeo: Float64Array; // all nodes, [x0, y0, …]
  edgeGeo: Float32Array; // all edge vertices
  starts: Uint32Array; // first vertex of each edge, plus the total at the end
  edgeSrc: Int32Array; // node index per edge
  edgeDst: Int32Array;
  vertexFrac: Float32Array; // fraction of arc length per vertex
  context: {
    rivers: { name: string; geo: Float32Array; neighbours: Int32Array; weights: Float32Array }[];
    labels: { name: string; kind: string; geo: Float32Array; neighbours: Int32Array; weights: Float32Array }[];
  };
}

export interface CostPositions {
  nodes: Float64Array; // all nodes
  edges: Float32Array; // all edge vertices
  rivers: Float32Array[];
  labels: Float32Array[];
}

export function buildGeometry(data: CostSpaceData): LayoutGeometry {
  const nodeGeo = Float64Array.from(data.nodes.geo);
  const index = new Map(data.nodes.ids.map((id, i) => [id, i]));
  const e = data.edges;
  const edgeGeo = Float32Array.from(e.geo);
  const starts = Uint32Array.from([...e.start_indices, e.geo.length / 2]);
  const edgeSrc = Int32Array.from(e.source.map((id) => index.get(id)!));
  const edgeDst = Int32Array.from(e.target.map((id) => index.get(id)!));

  const vertexFrac = new Float32Array(e.geo.length / 2);
  for (let k = 0; k < e.ids.length; k++) {
    const s = starts[k];
    const end = starts[k + 1];
    let total = 0;
    for (let v = s + 1; v < end; v++) {
      total += Math.hypot(edgeGeo[2 * v] - edgeGeo[2 * v - 2], edgeGeo[2 * v + 1] - edgeGeo[2 * v - 1]);
      vertexFrac[v] = total;
    }
    for (let v = s; v < end; v++) vertexFrac[v] = total > 0 ? vertexFrac[v] / total : 0;
  }

  const nearest = (pts: number[]) => {
    const count = pts.length / 2;
    const neighbours = new Int32Array(count * IDW_NEIGHBOURS);
    const weights = new Float32Array(count * IDW_NEIGHBOURS);
    const bestD = new Float64Array(IDW_NEIGHBOURS);
    const bestI = new Int32Array(IDW_NEIGHBOURS);
    for (let q = 0; q < count; q++) {
      bestD.fill(Infinity);
      const x = pts[2 * q];
      const y = pts[2 * q + 1];
      for (let i = 0; i < nodeGeo.length / 2; i++) {
        const d = (nodeGeo[2 * i] - x) ** 2 + (nodeGeo[2 * i + 1] - y) ** 2;
        if (d >= bestD[IDW_NEIGHBOURS - 1]) continue;
        let k = IDW_NEIGHBOURS - 1;
        while (k > 0 && bestD[k - 1] > d) {
          bestD[k] = bestD[k - 1];
          bestI[k] = bestI[k - 1];
          k--;
        }
        bestD[k] = d;
        bestI[k] = i;
      }
      let sum = 0;
      for (let k = 0; k < IDW_NEIGHBOURS; k++) sum += 1 / (bestD[k] + 1);
      for (let k = 0; k < IDW_NEIGHBOURS; k++) {
        neighbours[q * IDW_NEIGHBOURS + k] = bestI[k];
        weights[q * IDW_NEIGHBOURS + k] = 1 / (bestD[k] + 1) / sum;
      }
    }
    return { neighbours, weights };
  };

  return {
    nodeGeo,
    edgeGeo,
    starts,
    edgeSrc,
    edgeDst,
    vertexFrac,
    context: {
      rivers: data.context.lines.map((l) => ({ name: l.name, geo: Float32Array.from(l.geo), ...nearest(l.geo) })),
      labels: data.context.labels.map((l) => ({
        name: l.name,
        kind: l.kind,
        geo: Float32Array.from(l.geo),
        ...nearest(l.geo),
      })),
    },
  };
}

export function costPositions(g: LayoutGeometry, nodes: Float64Array): CostPositions {
  const edges = new Float32Array(g.edgeGeo.length);
  for (let k = 0; k < g.edgeSrc.length; k++) {
    const s = g.edgeSrc[k];
    const t = g.edgeDst[k];
    const x0 = nodes[2 * s];
    const y0 = nodes[2 * s + 1];
    if (s === t) {
      // closed ring: keep its shape, move it with its node
      const dx = x0 - g.nodeGeo[2 * s];
      const dy = y0 - g.nodeGeo[2 * s + 1];
      for (let v = g.starts[k]; v < g.starts[k + 1]; v++) {
        edges[2 * v] = g.edgeGeo[2 * v] + dx;
        edges[2 * v + 1] = g.edgeGeo[2 * v + 1] + dy;
      }
      continue;
    }
    const dx = nodes[2 * t] - x0;
    const dy = nodes[2 * t + 1] - y0;
    for (let v = g.starts[k]; v < g.starts[k + 1]; v++) {
      edges[2 * v] = x0 + g.vertexFrac[v] * dx;
      edges[2 * v + 1] = y0 + g.vertexFrac[v] * dy;
    }
  }

  const shift = (c: { geo: Float32Array; neighbours: Int32Array; weights: Float32Array }) => {
    const out = new Float32Array(c.geo.length);
    for (let q = 0; q < c.geo.length / 2; q++) {
      let dx = 0;
      let dy = 0;
      for (let k = 0; k < IDW_NEIGHBOURS; k++) {
        const i = c.neighbours[q * IDW_NEIGHBOURS + k];
        const w = c.weights[q * IDW_NEIGHBOURS + k];
        dx += w * (nodes[2 * i] - g.nodeGeo[2 * i]);
        dy += w * (nodes[2 * i + 1] - g.nodeGeo[2 * i + 1]);
      }
      out[2 * q] = c.geo[2 * q] + dx;
      out[2 * q + 1] = c.geo[2 * q + 1] + dy;
    }
    return out;
  };

  return {
    nodes,
    edges,
    rivers: g.context.rivers.map(shift),
    labels: g.context.labels.map(shift),
  };
}

export interface LiveLayout {
  positions: Float64Array | null; // node positions, null until cost-space data is loaded
  /** Layout length = cost × costScale (Σ cost is rescaled to Σ length). */
  costScale: number;
  running: boolean;
  quality: LayoutQuality | null;
}

/** Re-lays out the cost space in a Web Worker whenever the edge costs change. */
export function useLiveLayout(data: CostSpaceData | null, costs: EdgeCosts | null): LiveLayout {
  const [state, setState] = useState<LiveLayout>({
    positions: null,
    costScale: 1,
    running: false,
    quality: null,
  });
  const worker = useRef<Worker | null>(null);
  const job = useRef(0);

  // Layout edges: main component without self-loops, as in build_layout.py
  const layoutEdges = useMemo(() => {
    if (!data) return null;
    const index = new Map(data.nodes.ids.map((id, i) => [id, i]));
    const keep = data.edges.ids.map((_, k) => k).filter((k) => data.edges.source[k] !== data.edges.target[k]);
    return {
      ids: keep.map((k) => data.edges.ids[k]),
      src: Int32Array.from(keep.map((k) => index.get(data.edges.source[k])!)),
      dst: Int32Array.from(keep.map((k) => index.get(data.edges.target[k])!)),
      length: Float64Array.from(keep.map((k) => data.edges.length_m[k])),
    };
  }, [data]);

  useEffect(() => {
    if (!data || !layoutEdges) return;
    const w = new Worker(new URL("./layout.worker.ts", import.meta.url), { type: "module" });
    worker.current = w;
    w.onmessage = (e: MessageEvent<LayoutProgress>) => {
      if (e.data.job !== job.current) return;
      setState((s) => ({
        positions: e.data.positions,
        costScale: e.data.costScale,
        running: e.data.type === "progress",
        quality: e.data.quality ?? s.quality,
      }));
    };
    const init: LayoutInit = {
      type: "init",
      geo: Float64Array.from(data.nodes.geo),
      start: Float64Array.from(data.nodes.cost),
      src: layoutEdges.src,
      dst: layoutEdges.dst,
      length: layoutEdges.length,
      alpha: data.meta.alpha,
    };
    w.postMessage(init);
    setState({ positions: init.start, costScale: data.meta.cost_scale ?? 1, running: false, quality: null });
    return () => {
      w.terminate();
      worker.current = null;
    };
  }, [data, layoutEdges]);

  useEffect(() => {
    const w = worker.current;
    if (!w || !layoutEdges || !costs) return;
    const timer = setTimeout(() => {
      const cost = Float64Array.from(layoutEdges.ids.map((id, k) => costs.get(id) ?? layoutEdges.length[k]));
      const run: LayoutRun = { type: "run", job: ++job.current, cost };
      setState((s) => ({ ...s, running: true }));
      w.postMessage(run, [cost.buffer]);
    }, 60); // debounce slider drags
    return () => clearTimeout(timer);
  }, [costs, layoutEdges]);

  return state;
}
