# Walkable Basel

Team Kool Aid's project for the hackamrhein challenge.

**Where would shade help people on foot most?** Walkable Basel models the city's walkable network as a graph and combines it with the afternoon heat stress from the canton's urban climate model. It shows urban planners which streets are hot *and* hard to avoid on everyday walks, so that shading them (trees, awnings, arcades) removes the most heat from the most walks.

## Concept

A heat map already exists: the [Stadtklimaanalyse Basel-Stadt](#data-and-licences) maps the felt temperature (PET) on a 10 m grid. But a hot square that few people cross matters less than a moderately hot link that many walks must use, and a hot street with a shaded street next to it is less of a problem than one with no way around. Those are properties of the **network**, which a raster cannot show.

The project therefore:

1. turns Basel's walkable ways into a graph of **nodes** (intersections, junctions, dead ends) and **edges** (the path sections between them);
2. gives every edge a **walking cost**: its length, stretched by heat stress, for three **heat-sensitivity profiles** (low, medium, high);
3. simulates millions of everyday walks that avoid heat where they can, and ranks edges by the heat that remains on them: the **shade priority**.

The web app has three ways of looking at this:

- **Shade priority** (start view): the network coloured by where shade would remove the most heat from everyday walks, with a ranking of the top streets.
- **Walking cost**: the network coloured by heat factor, the cost of each metre.
- **Cost space**: the same network redrawn so that every edge is as long as its cost, while nodes stay close to their real location. Hot streets push the city apart, cool ones pull it together. An illustration, not an analysis.

Click any edge or node to inspect it. A glossary (book icon next to the title) explains the figures, the cost model and shade priority in the app itself.

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
OpenStreetMap ─┐
Stadtklima PET ├─▶ scripts/ ──▶ data/basel.duckdb ──▶ api/ (FastAPI) ──▶ web/ (React)
Tree cadastre ─┘
```

| Folder | What's in it |
|---|---|
| `scripts/` | Data pipeline: fetch OSM ways, build the graph, join heat (PET) and trees onto the edges, compute walking costs, the cost-space layouts and the shade priority |
| `data/` | `basel.duckdb`, the single database file, and the Stadtklima PET rasters |
| `api/` | FastAPI backend. Reads the database once at startup and serves JSON/GeoJSON under `/api` |
| `web/` | React + Vite frontend. MapLibre draws the geographic view, deck.gl the cost-space view |

### Rebuilding the data

You only need this to refresh the data or after changing a script. Run the scripts from the repo root, in this order:

```bash
python scripts/fetch_paths.py     # download walkable ways from OSM       -> paths
python scripts/fetch_context.py   # download rivers + district names      -> context_lines, context_labels
python scripts/build_graph.py     # cut ways into nodes and edges         -> nodes, edges, node_paths
python scripts/join_stadtklima_edges.py --replace  # PET raster per edge  -> edge_stadtklima
python scripts/join_trees_edges.py --replace       # trees near each edge -> trees, edge_trees
python scripts/build_layout.py    # cost per heat profile + layouts       -> edge_cost, node_layout, layout_meta
python scripts/build_leverage.py --replace  # shade priority (~30 s)      -> edge_leverage, leverage_meta
```

- The `join_` scripts key their tables on edge ids, which change with every `build_graph.py` run, so rerun them after it.
- `build_layout.py` needs `edge_stadtklima`, and `build_leverage.py` needs the costs from `build_layout.py`, so they run last.
- Internet access is needed by the two `fetch_` scripts (Overpass API, which is sometimes slow; the scripts fall back to mirror servers) and by the first run of `join_trees_edges.py`, which downloads the tree cadastre into the table `trees`. Everything else runs offline; `join_stadtklima_edges.py` reads the rasters in `data/`.
- Scripts that would replace an existing table stop unless you pass `--replace`.

If the API is running, tell it to load the new data:

```bash
curl -X POST localhost:8050/api/graph/reload
```

### API at a glance

| Endpoint | Returns |
|---|---|
| `GET /api/graph/meta` | Counts, bounds, value ranges, number of simulated walks |
| `GET /api/graph/edges` · `/nodes` | The whole graph as GeoJSON, with cost and shade priority per heat profile |
| `GET /api/graph/edges/{id}` · `/nodes/{id}` | Details of one edge or node |
| `GET /api/graph/leverage?profile=medium` | The streets where shade would help walkers most, with their share |
| `GET /api/layout/cost-space?profile=medium` | Node and edge positions on the map and in cost space for a heat profile (`low`, `medium`, `high`) |
| `POST /api/graph/reload` | Reload the database after a rebuild |

## Data and licences

| Data | Source | Used for | Licence / terms |
|---|---|---|---|
| Walkable ways, rivers, district names | [OpenStreetMap](https://www.openstreetmap.org) via the Overpass API (`fetch_paths.py`, `fetch_context.py`) | The graph; landmarks in the cost space | © OpenStreetMap contributors, [ODbL](https://opendatacommons.org/licenses/odbl/) |
| Physiological equivalent temperature (PET) at 14:00, today and 2030, 10 m raster | Stadtklimaanalyse Kanton Basel-Stadt, GEO-NET Umweltconsulting 2019 ([report](https://map.geo.bs.ch/file_proxy/KL_Stadtklima_Windstroemungsfeld/Endbericht_Basel_Klimaanalyse_Rev09_ohne_Anhang.pdf), [metadata](https://www.geocat.ch/geonetwork/srv/api/records/3ec2f4ca-900e-4f02-930c-3a5d862f67f7?language=eng)); files in `data/KL_Stadtklima_*` | Heat per edge, walking cost, shade priority | Public geodata of the canton, under the [terms of use for geodata of Basel-Stadt](https://shop.geo.bs.ch/geodaten-katalog/) |
| Tree cadastre (32,378 public trees) | [data.bs.ch dataset 100052](https://data.bs.ch/explore/dataset/100052/), Stadtgärtnerei Basel-Stadt | `trees`, `edge_trees` (prepared, not yet used) | CC BY 4.0 |
| Basemap tiles | [OpenFreeMap](https://openfreemap.org) | Background of the geographic view | Free, no API key; data © OpenStreetMap contributors |

## Methods

### Walkable network

`fetch_paths.py` loads every OSM way in Basel tagged as a footpath, pedestrian zone, steps or a street people can walk along; ways tagged `foot=no`, or private without explicit foot access, are left out. `build_graph.py` cuts the ways wherever they end or share a node, so bridges and tunnels crossing a path do not create fake intersections. Each section between two nodes becomes an undirected edge with its length in metres (Swiss LV95). Pedestrian squares mapped as areas are not part of the graph. 101 small networks that do not connect to the main one are shown faded and left out of the cost space and the shade priority.

### Heat per edge

`join_stadtklima_edges.py` samples the PET raster every metre along each edge. PET is the temperature at which a standard person would feel the same heat stress indoors; it combines air temperature, humidity, wind and, above all, sun or shade. The climate model behind it (FITNAH 3D) simulates a hot, cloudless summer day at 14:00, 2 m above ground; the 2030 scenario adds +1.2 K (RCP 4.5) and planned urban developments. Raster cells without a value (buildings) and points outside the raster are ignored. Per edge the script stores the length-weighted mean PET and the mean squared heat excess the cost model needs. Edges without any sample take the value of their neighbours.

### Walking cost

An edge's walking cost, in metres, is its length stretched by heat stress ([scripts/cost_model.py](scripts/cost_model.py)):

```
cost = length × mean over the edge's 1 m samples of (1 + (max(PET − 29 °C, 0) / scale)²)
```

- **29 °C threshold**: up to here the PET scale of VDI 3787 shows at most slight heat stress, so a metre costs a metre.
- **Quadratic**: above it, the hottest stretches get disproportionately expensive.
- **Per sample**: averaged over the 1 m samples, so a half-sunny edge keeps the cost of its sunny half.
- **Heat sensitivity** sets the scale, the degrees above 29 °C at which a metre costs double: low 16 °C, medium 12 °C, high 8 °C. At 41 °C (extreme heat stress) a metre then costs 1.6, 2 or 3.3 metres.

The app colours "walking cost" by the **heat factor**, cost ÷ length, on a fixed scale from 1× to 3×+, so the colour shows heat, not how long an edge is.

### Shade priority

`build_leverage.py` simulates about 4.2 million everyday walks: from 1,000 random start nodes of the main network, every node within 2 km along the shortest path is a destination. Each walk is routed with Dijkstra's algorithm the shortest way (by length) and, per heat profile, the coolest way (by cost), so walks avoid heat where a detour is worth it. Per edge it counts how many coolest routes still use it. The edge's **leverage** is

```
leverage = heat surcharge (cost − length) × walks whose coolest route uses the edge ÷ all walks
```

the heat that shading the edge, i.e. bringing its cost back to its length, would remove from everyday walks. The map colours edges by the percentile rank of their leverage (grey to beige for the lower 70 %, orange to red for the top 10 %). The ranking groups edges into streets (unnamed ways by their OSM way, labelled with a nearby street) and shows each street's share of the city's total leverage. The leverage correlates only weakly with PET itself (r ≈ 0.15): it is driven by how many walks depend on a stretch, not by heat alone.

### Cost space

`build_layout.py` treats the main network as an elastic net: each edge is a spring whose rest length is its cost, and each node is pulled gently toward its real position so the city stays recognisable. The positions minimise

```
Σ edges  w_ij (|p_i − p_j| − c_ij)²  +  α Σ nodes  W_i |p_i − g_i|²       w_ij = 1 / c_ij²,  α = 0.02
```

solved by stress majorization starting from the geographic positions, one layout per heat profile. Parallel edges are collapsed to the cheapest. The frontend morphs every vertex between its geographic and cost-space position; rivers and district names move with the nearest nodes. Dead ends with no other node within 150 m, mostly roads cut off where the data ends at the city border, are drawn faded.

### Trees (prepared, not used)

`join_trees_edges.py` counts the cadastre trees within 15 m of each edge (`tree_count`, `trees_per_100m`). They are not part of the cost model: PET already includes larger vegetation, and the report notes that only single trees, especially small ones, are missing at 10 m resolution, so adding the cadastre would partly count shade twice.

## Assumptions and limits

- **One afternoon.** PET describes 14:00 on a hot, cloudless summer day: a worst case, not an average day.
- **Heat-sensitivity profiles are assumptions.** Observed route choice weighs a sunny metre about 1.16 times a shaded one (Melnikov et al. 2022); all three profiles weigh heat more strongly. Shade priority depends on this choice.
- **Walks are simulated, not counted.** Start points are spread evenly and every nearby node is a destination, so busy places like stations or schools carry no extra weight.
- **First-order estimate.** Shading an edge is assumed to bring its cost back to its length; walks that would switch onto it once shaded are not counted.
- **Cost space is approximate.** Edge lengths match their cost only roughly, and long, expensive dead ends at the edge of the data reach far out.
- **Not yet used:** the 2030 PET scenario and the tree cadastre are in the database but not in the app.

## References

- GEO-NET Umweltconsulting (2019). *Stadtklimaanalyse Kanton Basel-Stadt: Grundlagen, Methoden, Ergebnisse.* Kanton Basel-Stadt. [PDF](https://map.geo.bs.ch/file_proxy/KL_Stadtklima_Windstroemungsfeld/Endbericht_Basel_Klimaanalyse_Rev09_ohne_Anhang.pdf)
- VDI 3787 Blatt 2 (2008). *Umweltmeteorologie: Methoden zur human-biometeorologischen Bewertung von Klima und Lufthygiene für die Stadt- und Regionalplanung, Teil I: Klima.* PET thresholds for heat stress.
- Melnikov, V. R. et al. (2022). Behavioural thermal regulation explains pedestrian path choices in hot urban environments. *Scientific Reports* 12, 2441. [doi:10.1038/s41598-022-06383-5](https://doi.org/10.1038/s41598-022-06383-5)
- Wolf, H., Vierø, A. R. & Szell, M. (2025). CoolWalks for active mobility in urban street networks. *Scientific Reports* 15, 14911. [doi:10.1038/s41598-025-97200-2](https://doi.org/10.1038/s41598-025-97200-2)
- Gansner, E. R., Koren, Y. & North, S. (2004). Graph drawing by stress majorization. *Graph Drawing 2004*, LNCS 3383, 239–250.

## Good to know

- **"Permission denied" on `basel.duckdb`**: the repo sits on a Windows drive, and a database viewer open on Windows (DBeaver, the DuckDB UI…) locks the file. Close it, then retry.
- **`basel.duckdb` is a binary file in Git LFS**: it cannot be merged. Pulling replaces your local copy, including tables you built yourself; rerun the scripts afterwards if needed.
- **Updating Python dependencies**: edit `requirements.in`, then run
  `uv pip compile requirements.in -o requirements.txt && uv pip sync requirements.txt --system`.
- **The basemap** comes from [OpenFreeMap](https://openfreemap.org) (free, no API key) and needs internet access. Without it the graph still shows, on a blank background.
- **Original plan**: the first plan for the web app, partly outdated, is in [web/PLAN.md](web/PLAN.md).
