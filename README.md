# hackamrhein_challenge
Repo for Kool Aid

# How to update dependencies
uv pip compile requirements.in -o requirements.txt

# then run
uv pip sync requirements.txt --system

## Data pipeline

```bash
python scripts/fetch_paths.py    # OSM -> data/basel.duckdb (table: paths), needs network
python scripts/fetch_context.py  # OSM rivers + district names for the cost-space view, needs network
python scripts/build_graph.py    # paths -> nodes, edges, node_paths (offline)
python scripts/build_layout.py   # nodes, edges -> node_layout, layout_meta (offline, ~1 s)
```

## Run the app

```bash
# API on :8050 (bind to all interfaces)
fastapi dev api/app.py --host 0.0.0.0 --port 8050

# Frontend on :5173 (proxies /api to :8050)
cd web && npm install && npm run dev
```

Open http://localhost:5173 in the host browser. API docs: http://localhost:8050/docs

<<<<<<< HEAD
After `cd web && npm run build`, the API also serves the built frontend at http://localhost:8050/.

After rebuilding the graph or layout while the API runs: `curl -X POST localhost:8050/api/graph/reload`.

The UI roadmap is in [web/PLAN.md](web/PLAN.md).
=======
Default pages:
- Root: http://localhost:8050/
- OpenAPI UI: http://localhost:8050/docs



# Datasets

Humanbioklimatische Situation, Kanton Basel-Stadt

Source: Geodaten Kanton Basel-Stadt
License: CC BY 4.0
https://creativecommons.org/licenses/by/4.0/

The original dataset is distributed by the Kanton Basel-Stadt.
>>>>>>> 96207cefcce5a0b21d9fd6a7fd826d4b38ba2232
