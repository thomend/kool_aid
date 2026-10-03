# Walkable Basel

Team Kool Aid's project for the hackamrhein challenge: how hard is it to walk through Basel on a hot summer afternoon, and what helps?

## Initial situation

Summers in Basel are getting hotter. For people on foot, 500 m in full sun is far more exhausting than 500 m in the shade, and for elderly people, small children or anyone with a heart condition it can be dangerous. Maps only show distance, so this difference stays invisible, and planners lack an overview of where the walking network fails in the heat.

## Goal

Show where walking in Basel is hard in the heat, how much harder, and what trees and fountains change, as a basis for planning decisions: where to plant, where a fountain is missing, which connections need a cooler alternative.

## Who it's for

- **City planners and administration** (urban planning, green spaces): find heat-stressed areas and connections, compare the effect of trees and fountains.
- **Politics and the public**: a picture of the problem that anyone understands in seconds.
- **Heat-sensitive people** are represented by the profiles, so effects can be judged for those who need it most.

## How we achieve it

The walkable network (paths, sidewalks, streets) is a graph: intersections are nodes, the sections between them edges. Every edge gets a **walking cost**: its length, stretched by heat stress and softened by tree shade and nearby fountains. The web app shows it in two views:

- **Geographic**: the network on a map, each street coloured by heat cost per metre (teal = cooler, red = hotter than a typical metre). Click a street for details: cost, PET, tree shade, nearest fountain.
- **Cost space**: Basel as it feels on a hot afternoon. A cartogram grows every neighbourhood by how much harder it is to walk there and shrinks it where it is easier; streets, rivers, labels and a tinted grid warp with it. A slider morphs between map and cost space.

In the panel:

- **Heat sensitivity** (low, medium, high) sets how strongly heat counts.
- **Count in** switches tree shade and fountains on or off, to see what they change.
- **Compare routes**: pick two points to see the shortest route next to the coolest one, how much longer the cool one is and how much heat stress it avoids.

## How costs are calculated

```
cost   = length × (1 + heat_excess × relief / scale²)
relief = (1 − 0.5 × shade_share) × (1 − 0.2 × fountain_share)
```

- **heat_excess**: mean of max(PET − 29 °C, 0)² over the edge's 1 m samples. PET (physiological equivalent temperature) below 29 °C is at most slight heat stress (VDI 3787) and costs just the distance; above, the cost grows quadratically.
- **scale** per heat-sensitivity profile: the degrees above 29 °C at which a metre costs double. At 41 °C PET, an unshaded metre costs 1.56× (low, 16 °C), 2× (medium, 12 °C) or 3.25× (high, 8 °C).
- **shade_share**: share of the edge under a public tree's crown (within 6 m, 9 m from street centrelines). Full shade halves the heat part.
- **fountain_share**: share of the edge within 100 m of a fountain. A fountain within reach removes a fifth of the heat part.
- Relief only lowers the heat part, so missing trees or fountains never add cost.

Colours, cost space and routes use the same formula. Colours and cost space are measured against a fixed reference, the median cost per metre **without** trees and fountains, so switching them on visibly cools the city down. In the cost space, area grows with (cost per metre ÷ reference)⁶. This exaggerates the effect to make it visible, so compare areas with each other, not with distances. Details: [scripts/cost_model.py](scripts/cost_model.py), [scripts/build_layout.py](scripts/build_layout.py).

## Data

| Data | Source |
|---|---|
| Walkable ways, rivers, district names | [OpenStreetMap](https://www.openstreetmap.org) via the Overpass API |
| Heat stress: PET at 14:00, 10 m raster (today; 2030 also in the repo, not yet used) | Stadtklimaanalyse Basel-Stadt, Humanbioklimatische Situation (`data/KL_Stadtklima_*`) |
| Public trees (tree cadastre) | [data.bs.ch, dataset 100052](https://data.bs.ch/explore/assets/100052/) |
| Bathing, drinking and decorative fountains | [data.bs.ch, dataset 100008](https://data.bs.ch/explore/assets/100008/) |
| Basemap tiles | [OpenFreeMap](https://openfreemap.org) |

Everything is prepared in one DuckDB file, `data/basel.duckdb`, which is in the repo.

## Quick start

Everything runs in the devcontainer (Python 3.12, Node 24); no data download is needed.

```bash
fastapi dev api/app.py --host 0.0.0.0 --port 8050   # API, docs at http://localhost:8050/docs
cd web && npm install && npm run dev                 # app at http://localhost:5173 (second terminal)
```

Without the Vite dev server: `cd web && npm run build`, then the API serves the app at http://localhost:8050.

```
OSM, data.bs.ch, Stadtklima ──▶ scripts/ ──▶ data/basel.duckdb ──▶ api/ (FastAPI) ──▶ web/ (React, MapLibre, deck.gl)
```

## Rebuilding the data

Only needed to refresh the data or after changing a script. From the repo root, in this order:

```bash
python scripts/fetch_paths.py              # walkable ways from OSM          -> paths
python scripts/fetch_context.py            # rivers, district names          -> context_lines, context_labels
python scripts/build_graph.py              # nodes and edges                 -> nodes, edges, node_paths
python scripts/join_stadtklima_edges.py    # PET along each edge             -> edge_stadtklima
python scripts/join_trees_edges.py         # tree cadastre, shade per edge   -> trees, edge_trees
python scripts/join_fountains_edges.py     # fountains, reach per edge       -> fountains, edge_fountains
python scripts/build_layout.py             # costs + cartograms (~2.5 min)   -> edge_heat, cost_model, layout_warp, layout_meta
```

The `fetch_` scripts and the first run of the tree and fountain scripts need internet access. Edge ids change with every `build_graph.py` run, so rerun the `join_` scripts with `--replace` afterwards. Then reload the running API: `curl -X POST localhost:8050/api/graph/reload`.

## API

| Endpoint | Returns |
|---|---|
| `GET /api/graph/meta` | Counts, bounds, cost-model constants |
| `GET /api/graph/edges` · `/nodes` | The whole graph as GeoJSON |
| `GET /api/graph/edges/{id}` · `/nodes/{id}` | One edge or node |
| `GET /api/layout/cost-space?profile=medium&trees=true&fountains=true` | Map and cost-space positions for a profile and relief variant |
| `GET /api/route?start=lon,lat&end=lon,lat&profile=medium&trees=true&fountains=true` | Shortest and coolest walking route between two points |
| `POST /api/graph/reload` | Reload the database after a rebuild |

## Good to know

- **"Permission denied" or a lock on `basel.duckdb`**: the repo sits on a Windows drive, and a database viewer open on Windows (DBeaver, the DuckDB UI…) locks the file; so does a running pipeline script. Close it and retry, and restart `fastapi dev` if it stopped during a rebuild.
- **The basemap** needs internet access; without it the network still shows, on a blank background.
- **Python dependencies**: edit `requirements.in`, then `uv pip compile requirements.in -o requirements.txt && uv pip sync requirements.txt --system`.
- **Roadmap and ideas**: [web/PLAN.md](web/PLAN.md).
