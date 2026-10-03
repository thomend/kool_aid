# Walkable Basel

Team Kool Aid's project for the hackamrhein challenge.

An interactive map of Basel's **walkable network** as a graph: intersections are nodes and the path sections between them are edges, each with a cost. The cost is the length in metres for now; a richer cost model (trees, steps, slope…) is planned.

The web app has two views:

- **Geographic**: the graph on a calm, abstract map of Basel. Edges are coloured by cost or by path type (footpath, pedestrian zone, steps, street). Click any node or edge to inspect it.
- **Cost space**: the same graph redrawn so that each edge's on-screen length equals its cost, while staying close to its real location. Switching views animates the city between the two layouts, and a slider lets you stop anywhere in between.

Data comes from OpenStreetMap, is stored in DuckDB, and is served to a React frontend by a FastAPI backend.

## Quick start

Everything runs in the devcontainer (Python 3.12, Node 24). The prepared database `data/basel.duckdb` is in the repo, so no data download is needed.

```bash
# 1. API on http://localhost:8050
fastapi dev api/app.py --host 0.0.0.0 --port 8050

# 2. Frontend on http://localhost:5173 (second terminal)
cd web
npm install      # first time only
npm run dev
```

Open **http://localhost:5173**. The interactive API docs are at http://localhost:8050/docs.

To run without the Vite dev server, build the frontend once (`cd web && npm run build`). The API then serves the app itself at http://localhost:8050.

## How it works

```
OpenStreetMap ──▶ scripts/ ──▶ data/basel.duckdb ──▶ api/ (FastAPI) ──▶ web/ (React)
```

| Folder | What's in it |
|---|---|
| `scripts/` | Data pipeline: download from OSM, build the graph, compute the cost-space layout |
| `data/` | `basel.duckdb`, the single database file |
| `api/` | FastAPI backend. Reads the database once at startup and serves JSON/GeoJSON under `/api` |
| `web/` | React + Vite frontend. MapLibre draws the geographic view, deck.gl the cost-space view |

### Rebuilding the data

You only need this to refresh the OSM data or after changing a script. Run the scripts from the repo root, in this order:

```bash
python scripts/fetch_paths.py     # download walkable ways from OSM       -> table paths
python scripts/fetch_context.py   # download rivers + district names      -> context_lines, context_labels
python scripts/build_graph.py     # cut ways into nodes and edges         -> nodes, edges, node_paths
python scripts/build_layout.py    # compute the cost-space layout (~1 s)  -> node_layout, layout_meta
```

The two `fetch_` scripts need internet access (Overpass API, which is sometimes slow; the scripts fall back to mirror servers). The two `build_` scripts run offline.

If the API is running, tell it to load the new data:

```bash
curl -X POST localhost:8050/api/graph/reload
```

### API at a glance

| Endpoint | Returns |
|---|---|
| `GET /api/graph/meta` | Counts, bounds, value ranges |
| `GET /api/graph/edges` · `/nodes` | The whole graph as GeoJSON |
| `GET /api/graph/edges/{id}` · `/nodes/{id}` | Details of one edge or node |
| `GET /api/layout/cost-space` | Node and edge positions on the map and in cost space |
| `POST /api/graph/reload` | Reload the database after a rebuild |

## Good to know

- **"Permission denied" on `basel.duckdb`**: the repo sits on a Windows drive, and a database viewer open on Windows (DBeaver, the DuckDB UI…) locks the file. Close it, then retry.
- **Updating Python dependencies**: edit `requirements.in`, then run
  `uv pip compile requirements.in -o requirements.txt && uv pip sync requirements.txt --system`.
- **The basemap** comes from [OpenFreeMap](https://openfreemap.org) (free, no API key) and needs internet access. Without it the graph still shows, on a blank background.
- **Roadmap**: routing, the cost model and cost-space improvements are planned in [web/PLAN.md](web/PLAN.md).
