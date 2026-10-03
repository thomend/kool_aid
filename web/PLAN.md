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
                               │ join_*_edges.py, build_layout.py
                               ▼
              edge_heat · cost_model · layout_warp · layout_meta
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
| — | `cost` column on edges | advanced cost model, replaces `length_m` as the routing weight |

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

### Phase 3 – Cost model
- `cost` column on edges, computed by a separate script (factors such as
  steps, slope, surface, crossings, sidewalk presence, pedestrian zones).
- UI colours by `cost`, with a breakdown of cost factors in the edge inspector.
- Optional: user-tunable weights (sliders) that recompute routes live.

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
