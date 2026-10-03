// Live cost-space layout, the TypeScript twin of majorize() in
// scripts/build_layout.py. Every edge is a spring whose rest length is its
// (rescaled) cost; every node is pulled toward its geographic position:
//
//   minimise  Σ_edges w (|p_i − p_j| − c_ij)²  +  alpha · Σ_nodes W_i |p_i − g_i|²
//
// solved by localized stress majorization (Jacobi updates), warm-started from
// the current positions so small cost changes settle in a few iterations.
// Costs are rescaled so Σ cost = Σ length: the city keeps its size.
//
// Runs in chunks so a new job (new costs) can interrupt a running one, and
// streams intermediate positions so the city visibly relaxes.

export interface LayoutInit {
  type: "init";
  geo: Float64Array; // [x0, y0, x1, y1, …] geographic node positions
  start: Float64Array; // initial positions (the precomputed layout)
  src: Int32Array; // node index per layout edge (self-loops excluded)
  dst: Int32Array;
  length: Float64Array; // edge length in metres, for the rescaling
  alpha: number;
}

export interface LayoutRun {
  type: "run";
  job: number;
  cost: Float64Array; // cost per layout edge, aligned with src/dst
}

export interface LayoutQuality {
  edgeStretchP05: number; // on-screen edge length / rescaled cost
  edgeStretchP95: number;
  displacementMaxM: number; // largest distance of a node from its geographic position
  iterations: number;
}

export interface LayoutProgress {
  type: "progress" | "done";
  job: number;
  positions: Float64Array;
  /** Layout length = cost × costScale; 1 m on screen is 1 / costScale m of cost. */
  costScale: number;
  quality?: LayoutQuality;
}

const TOLERANCE = 1e-3; // mean node movement per iteration (m), as in build_layout.py
const MAX_ITERATIONS = 3000;
const CHUNK_MS = 12;
const POST_EVERY_MS = 40;

let n = 0;
let geo: Float64Array = new Float64Array();
let pos: Float64Array = new Float64Array();
let next: Float64Array = new Float64Array();
let length: Float64Array = new Float64Array();
let alpha = 0.02;
// Parallel edges collapse to one spring per node pair (the cheapest)
let pairA = new Int32Array();
let pairB = new Int32Array();
let pairOfEdge = new Int32Array();
let currentJob = -1;

function init(msg: LayoutInit) {
  n = msg.geo.length / 2;
  geo = msg.geo;
  pos = Float64Array.from(msg.start);
  next = new Float64Array(pos.length);
  length = msg.length;
  alpha = msg.alpha;
  const pairs = new Map<number, number>();
  const a: number[] = [];
  const b: number[] = [];
  pairOfEdge = new Int32Array(msg.src.length);
  for (let e = 0; e < msg.src.length; e++) {
    const i = Math.min(msg.src[e], msg.dst[e]);
    const j = Math.max(msg.src[e], msg.dst[e]);
    const key = i * n + j;
    let p = pairs.get(key);
    if (p === undefined) {
      p = a.length;
      pairs.set(key, p);
      a.push(i);
      b.push(j);
    }
    pairOfEdge[e] = p;
  }
  pairA = Int32Array.from(a);
  pairB = Int32Array.from(b);
}

function run(job: number, cost: Float64Array) {
  currentJob = job;
  let lengthSum = 0;
  let costSum = 0;
  for (let e = 0; e < cost.length; e++) {
    lengthSum += length[e];
    costSum += cost[e];
  }
  const scale = lengthSum / costSum;

  const m = pairA.length;
  const D = new Float64Array(m).fill(Infinity);
  for (let e = 0; e < cost.length; e++) {
    const p = pairOfEdge[e];
    D[p] = Math.min(D[p], cost[e] * scale);
  }
  const W = new Float64Array(m);
  const wSum = new Float64Array(n);
  for (let p = 0; p < m; p++) {
    W[p] = 1 / Math.max(D[p], 1) ** 2; // floor at 1 m so tiny edges don't dominate
    wSum[pairA[p]] += W[p];
    wSum[pairB[p]] += W[p];
  }
  const anchor = new Float64Array(n);
  const denom = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    anchor[i] = alpha * wSum[i];
    denom[i] = wSum[i] + anchor[i];
  }

  let iteration = 0;
  let lastPost = performance.now();

  const step = (): boolean => {
    next.fill(0);
    for (let p = 0; p < m; p++) {
      const i = pairA[p];
      const j = pairB[p];
      const dx = pos[2 * i] - pos[2 * j];
      const dy = pos[2 * i + 1] - pos[2 * j + 1];
      const k = D[p] / Math.max(Math.hypot(dx, dy), 1e-9);
      const w = W[p];
      // i wants to sit at distance D from j along the current direction, and vice versa
      next[2 * i] += w * (pos[2 * j] + k * dx);
      next[2 * i + 1] += w * (pos[2 * j + 1] + k * dy);
      next[2 * j] += w * (pos[2 * i] - k * dx);
      next[2 * j + 1] += w * (pos[2 * i + 1] - k * dy);
    }
    let move = 0;
    for (let i = 0; i < n; i++) {
      if (denom[i] === 0) {
        next[2 * i] = geo[2 * i];
        next[2 * i + 1] = geo[2 * i + 1];
      } else {
        next[2 * i] = (next[2 * i] + anchor[i] * geo[2 * i]) / denom[i];
        next[2 * i + 1] = (next[2 * i + 1] + anchor[i] * geo[2 * i + 1]) / denom[i];
      }
      move += Math.hypot(next[2 * i] - pos[2 * i], next[2 * i + 1] - pos[2 * i + 1]);
    }
    [pos, next] = [next, pos];
    iteration++;
    return move / n < TOLERANCE || iteration >= MAX_ITERATIONS;
  };

  const chunk = () => {
    if (job !== currentJob) return; // superseded by newer costs
    const until = performance.now() + CHUNK_MS;
    let done = false;
    while (!done && performance.now() < until) done = step();
    if (done) {
      post({ type: "done", job, positions: Float64Array.from(pos), costScale: scale, quality: quality(D, iteration) });
      return;
    }
    if (performance.now() - lastPost > POST_EVERY_MS) {
      lastPost = performance.now();
      post({ type: "progress", job, positions: Float64Array.from(pos), costScale: scale });
    }
    setTimeout(chunk, 0); // let a newer "run" message in
  };
  chunk();
}

function quality(D: Float64Array, iterations: number): LayoutQuality {
  const stretch = new Float64Array(pairA.length);
  for (let p = 0; p < pairA.length; p++) {
    const i = pairA[p];
    const j = pairB[p];
    stretch[p] = Math.hypot(pos[2 * i] - pos[2 * j], pos[2 * i + 1] - pos[2 * j + 1]) / Math.max(D[p], 1e-6);
  }
  stretch.sort();
  let displacementMaxM = 0;
  for (let i = 0; i < n; i++) {
    displacementMaxM = Math.max(
      displacementMaxM,
      Math.hypot(pos[2 * i] - geo[2 * i], pos[2 * i + 1] - geo[2 * i + 1]),
    );
  }
  const at = (q: number) => stretch[Math.floor((stretch.length - 1) * q)];
  return { edgeStretchP05: at(0.05), edgeStretchP95: at(0.95), displacementMaxM, iterations };
}

function post(msg: LayoutProgress) {
  (self as unknown as Worker).postMessage(msg, [msg.positions.buffer]);
}

self.onmessage = (e: MessageEvent<LayoutInit | LayoutRun>) => {
  if (e.data.type === "init") init(e.data);
  else run(e.data.job, e.data.cost);
};
