# Walkable Basel – UI & API plan

Where the frontend is going, and what is already built. Keep this up to date
as phases land.

## Vision

A beautiful, calm, Apple-Maps-like interface for exploring and routing on
Basel's walkable network. Two ways of looking at the same graph:

1. **Geographic view**: the graph drawn exactly where it is, edges coloured by
   cost, on an abstract basemap (not satellite imagery).
2. **Cost-space view**: the same graph laid out so that edge length on screen
   is proportional to edge *cost*, while nodes keep their rough geographic
   position relative to each other, so the city stays recognisable.

Everything the UI shows comes from our FastAPI backend, which reads the DuckDB
built by `scripts/fetch_paths.py` and `scripts/build_graph.py`.

## Architecture

```
OSM ──fetch_paths.py────▶ data/basel.duckdb (paths)
OSM ──fetch_context.py──▶ context_lines · context_labels (rivers, districts)
                               │ build_graph.py
                               ▼
                         nodes · edges · node_paths
                               │ build_layout.py
                               ▼
                         node_layout · layout_meta
                               │ read once at startup (read-only, in memory)
                               ▼
                    FastAPI  api/app.py + api/graph.py   :8050
                               │ JSON / GeoJSON, gzip
                               ▼
               React + Vite + MapLibre GL  web/          :5173 (dev)
                     basemap: OpenFreeMap vector tiles, own style
```

- **Basemap**: OpenFreeMap vector tiles (OpenMapTiles schema, no API key),
  styled in `src/map/basemap.ts`. Light and dark palettes; streets kept faint
  so the graph stands out.
- **Graph rendering**: MapLibre GeoJSON sources fed straight from the API.
  Hover and selection use feature-state, so no re-upload is needed.
- **Cost-space rendering**: deck.gl (`OrthographicView`, metres, north up) on a
  plain canvas, loaded on demand. Binary path/point attributes; the morph
  interpolates every vertex between its geographic and cost-space position.
- **Styling**: plain CSS with design tokens (`src/styles.css`), system font
  stack (SF Pro on Apple devices, Inter elsewhere), frosted-glass panels,
  light/dark following the OS with a manual toggle.
- **Production**: `npm run build` → `web/dist`, served by FastAPI at `/`
  (same origin as `/api`).

## API

### Implemented (`/api/graph`)

| Method | Path | Returns |
|---|---|---|
| GET | `/meta` | counts, bounds, length quantiles, highway and node-type counts |
| GET | `/edges` | GeoJSON LineStrings with id, source, target, way_osm_id, street_name, highway, is_pedestrian, length_m, component |
| GET | `/nodes` | GeoJSON Points with id, degree, node_type, component |
| GET | `/nodes/{id}` | node + street names + incident edges |
| GET | `/edges/{id}` | one edge's attributes |
| POST | `/reload` | re-reads DuckDB (graph and layout) after a rebuild |

### Implemented (`/api/layout`)

| Method | Path | Returns |
|---|---|---|
| GET | `/cost-space` | layout meta, origin, bounds; nodes and edges as columnar arrays with flat `geo` and `cost` coordinates (metres from `origin_lv95`, identical vertex counts); rivers and district labels in both spaces |
| POST | `/reload` | re-reads the layout only |

OpenAPI docs: <http://localhost:8050/docs>.

### Planned

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/route?from=<node>&to=<node>` | shortest path (networkx, weight = cost) → GeoJSON + total cost |
| GET | `/api/nearest?lon=&lat=` | snap a clicked point to the nearest node (for routing by map click) |
| GET | `/api/search?q=` | street name search → fly to street |

When the data grows beyond a few MB, switch `/edges` from GeoJSON to vector
tiles (PMTiles via tippecanoe, or DuckDB spatial `ST_AsMVT`).

## Phases

### Phase 1 – Geographic view ✅ (built)
- Abstract basemap of Basel, light and dark.
- Graph edges coloured by cost (= length for now) or by path type.
- Nodes appear from zoom 14.5 (intersections and dead ends).
- Hover tooltip, click to inspect node or edge, navigate node ↔ edge.
- Stats panel, legend, zoom / reset / theme controls, mobile layout.
- View switcher with "Cost space" marked as coming soon.

### Phase 2 – Routing
- Pick start and destination by clicking the map or searching a street.
- `/api/route` returns the path; draw it as an animated, glowing line with
  distance and walking time (≈ 1.3 m/s) in a route card.
- Clicked points are snapped to the nearest node in the main component.

### Phase 3 – Dynamic cost model

Goal: users pick a predefined cost function or set their own, switch factors
on/off, adjust weights, and (later) edit values of editable factors; both
views follow live.

#### Formula (`scripts/cost_model.py`, mirrored in `web/src/cost.ts`)

```
cost(edge) = length_m × max(0.1, Σ_k  weight_k · x_k)
x_k        = 1                                   constant factors (distance)
           = max(value_k − threshold_k, 0)      otherwise; missing values → 0
```

Every factor adds a multiple of the length; a factor that is off has weight 0.
The 0.1 floor keeps costs positive (distance off on cool streets, trees later).

#### Factors

| Factor | Kind | Values | Variants | Default weight |
|---|---|---|---|---|
| distance | static, constant | x = 1 | – | 1 (every metre counts once) |
| heat | static (read-only data) | PET at 14:00, threshold 23 °C | today / 2030, one at a time | 1/18 (41 °C ⇒ ×2) |
| trees *(planned)* | editable | trees per edge; users change per edge or globally | – | negative |

Weights are adjustable for both kinds. When trees arrive, added trees should
also cool the edge (lower its PET), not only lower the cost directly.

#### Presets (`cost_functions`)
"Distance" (all off), "Heat today" (default), "Heat 2030".

#### 3a – Cost model with heat ✅ (built)
- `scripts/cost_model.py`: factors (with data variants), presets, `evaluate()`.
- `scripts/build_factors.py` → `edge_factors` (edge_id, length_m, pet_c,
  pet_2030_c), `factors`, `cost_functions`.
- `build_layout.py` uses the default preset (identical to the previous
  hard-coded heat cost) and rescales costs so Σ cost = Σ length for the layout
  (stops the network from crumpling; max node shift 2.2 km → 0.27 km).
  `edge_cost` is still written for the existing API fields.
- API: `GET /api/cost/model`, `GET /api/cost/edge-factors`.
- UI: one panel per factor (on/off switch, today/2030 choice, weight slider);
  presets stay in the model but have no buttons. Colour modes: total cost
  (fixed 5 m … 250 m+ scale), cost per metre (fixed ×1 … ×2.25+) and path
  type. Fixed scales make every change visible (heat on = hotter; with
  distance only, total cost shows edge length and per metre is uniform ×1). Tooltips and the inspector (cost
  breakdown per factor) follow instantly. Cost space shows a notice while the
  layout was computed with other settings.
- Costs reach MapLibre as feature-state `cost` and `perM`; they are pushed again after
  every restyle (theme / colour mode), which can rebuild the edge source.

#### 3b – Live cost space ✅ (built)
- `web/src/layout.worker.ts`: `majorize()` ported to TypeScript, same springs,
  geographic pull (alpha from `layout_meta`) and Σ cost = Σ length rescaling.
  Warm-started from the current positions, runs in 12 ms chunks so newer
  costs interrupt older jobs, streams positions every ~40 ms.
- `web/src/costLayout.ts`: `useLiveLayout` (debounced 60 ms) and the geometry:
  edges straight between their nodes (drawn length ∝ cost), rivers/labels via
  IDW of the 8 nearest nodes' displacement (precomputed once).
- Matches the Python layout: heat today ±11 % / max shift 267 m (Python 268 m),
  heat off ±2 % / 143 m (Python 143 m). Settles in ~1–2.5 s in a software-
  rendered headless browser.
- Because of the rescaling, a factor that raises all costs alike changes the
  scale, not the shape; the scale bar shows real cost (1 m on screen =
  1 / costScale m of cost). The precomputed layout is only the warm start.

#### 3c – Editable factors: trees
- Tree data per edge (Basel tree inventory) as baseline.
- Per-edge −/+ in the inspector, global "+N trees per 100 m"; trees lower
  cost and PET.
- Optional: save/share edits via `/api/scenarios` (separate store).

### Phase 4 – Cost-space view ✅ (built, global layout)
- `scripts/build_layout.py`: elastic network. Every edge is a spring with rest
  length = cost (weight 1/cost²), every node is pulled toward its geographic
  position (`--alpha`, default 0.02). Solved by stress majorization from the
  geographic positions, ~1 s. `edge_cost()` is the single place to plug in
  the cost model.
- Tried and rejected: sparse stress with shortest-path pivot terms. Path
  distances exceed straight-line distances, so the whole city inflates
  (edges stretched ~1.5×) and dead ends fling outward – unreadable.
- Edges are drawn straight between their cost-space nodes (so drawn length =
  cost), with the same vertex count as the real geometry for the morph.
  Rivers and district labels are moved by inverse-distance-weighted node
  displacement.
- UI: view switch hands the camera over (same place and scale), the graph
  morphs geography → cost space; a slider scrubs the morph. Panel shows how
  well edge lengths match cost and the largest node shift.
- With cost = length the layout stays close to geography (only winding paths
  straighten); it becomes expressive once the cost model (Phase 3) exists.

### Phase 4b – Cost space from one point
- Click a node: every node's distance from it = path cost, direction kept
  (radial "how far is everything from here" map). One Dijkstra per click on
  the server, rendered with the same morph machinery.

### Phase 5 – Polish
- Street search with autocomplete.
- Isochrones ("everything within 10 minutes' walk").
- Shareable URLs (view, selection, route in the query string).
- Self-hosted basemap tiles (PMTiles extract of Basel) to drop the external tile dependency.

## Running

```bash
# backend (from repo root)
fastapi dev api/app.py --port 8050

# frontend (from web/)
npm install
npm run dev          # http://localhost:5173, proxies /api to :8050
```
