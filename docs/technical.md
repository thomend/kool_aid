# Walkable Basel – Technical documentation

What the project does and why is in the [README](../README.md). This document explains how it works: architecture, technologies, the procedures behind each feature, where data is stored, and what the heat data (PET) actually contains.

## 1. Architecture

```
 Data sources                 Pipeline (Python, offline)        Storage           Backend            Frontend
 ────────────                 ──────────────────────────        ───────           ───────            ────────
 OpenStreetMap (Overpass) ─┐  fetch_paths, fetch_context
 Stadtklima PET rasters ───┤  build_graph                      data/
 Tree cadastre (data.bs.ch)┼─▶ join_stadtklima / _trees /  ──▶  basel.duckdb ──▶ FastAPI api/ ──▶ React web/
 Fountains (data.bs.ch) ───┤  _fountains / _slope_edges         (one file)        read once,        MapLibre: map
 swissALTI3D (swisstopo) ──┘  build_layout (costs, cartograms)                    in memory         deck.gl: cost space
```

Three layers, each with one job:

- **Pipeline** (`scripts/`): turns raw data into a graph with cost ingredients per edge and pre-computed cost-space warps. Runs offline, takes minutes, writes only to DuckDB.
- **Backend** (`api/`): reads the database once at startup (read-only, so it never locks the file) and keeps everything in memory. Serves JSON/GeoJSON, builds cost-space payloads on demand and computes routes.
- **Frontend** (`web/`): a single-page React app. It computes costs and colours itself from the ingredients, so switching profile or factors is instant without a round trip.

The cost formula lives in four places that must agree: `scripts/cost_model.py` (pipeline), `api/routing.py` (routes), `web/src/costModel.ts` (browser) and the MapLibre expression in `web/src/map/style.ts` (map colours). The constants are written once by the pipeline (table `cost_model`, `layout_meta`) and passed through the API, so only the formula itself is duplicated.

## 2. Technologies

| Layer | Technology | Used for |
|---|---|---|
| Data | Python 3.12, DuckDB 1.5 | Pipeline scripts, single-file analytical database |
| Geodata | shapely 2, pyproj, rasterio, numpy, pandas | Geometry, LV95 ↔ WGS84, raster sampling, array maths |
| Backend | FastAPI, uvicorn, pydantic | REST API, response models, interactive docs at `/docs` |
| Frontend | React 19, TypeScript, Vite | UI, build and dev server |
| Map | MapLibre GL 6 + OpenFreeMap vector tiles | Geographic view and basemap |
| Cost space | deck.gl 9 (orthographic view) | GPU drawing of the warped network, cells, grid, routes |
| Dev | devcontainer, uv, ruff | Reproducible environment, dependencies, linting |

No graph library and no GIS server: routing (Dijkstra) and the cartogram are implemented directly with the standard library and numpy.

## 3. What is saved where

| Where | What | Written by |
|---|---|---|
| `data/basel.duckdb` (in git via LFS) | Everything the app needs, see the tables below | pipeline |
| `data/KL_Stadtklima_*/` (in git via LFS) | PET rasters today and 2030 (GeoTIFF + world file) | downloaded manually |
| `data/cache/swissalti3d/` (not in git) | 79 terrain tiles, 79 MB | `join_slope_edges.py` |
| API memory | Graph, GeoJSON, cost-space payloads (built on demand, cached) | `api/graph.py`, `api/layout.py` |
| Browser | Current view, profile, factors, picked route; nothing persists | `web/src/App.tsx` |

Tables in `basel.duckdb`:

| Table | Rows | Content |
|---|---|---|
| `paths` | 11,589 | Walkable OSM ways (highway, surface, sidewalk …) and merged named streets |
| `nodes`, `edges`, `node_paths` | 14,579 / 19,477 | The graph: nodes with type and component, edges with length and geometry |
| `context_lines`, `context_labels` | 15 / 21 | Rivers and district names for orientation in the cost space |
| `edge_stadtklima` | 19,477 | PET today and 2030 per edge, squared heat excess |
| `trees`, `edge_trees` | 32,378 / 19,477 | Tree cadastre; trees within 15 m and shade share per edge |
| `fountains`, `edge_fountains` | 305 / 19,477 | Fountains; nearest fountain and fountain share per edge |
| `way_structures`, `edge_slope` | 775 / 19,477 | OSM bridges and tunnels; gradient and slope excess per edge |
| `edge_heat` | 19,250 | The cost ingredients per main-network edge (heat excess, shade, fountain, slope) |
| `cost_model` | 1 | Constants of the formula (PET threshold, shade and fountain effect) |
| `layout_meta`, `layout_warp` | 24 / 24 | Per profile and factor variant: reference, statistics and the cartogram warp |

All coordinates in the pipeline are Swiss LV95 (EPSG:2056, metres); GeoJSON for the map is WGS84.

## 4. Procedures

### 4.1 Building the graph (`build_graph.py`)

- A **node** is every OSM node that ends a way or is shared by several ways. Bridges crossing a path share no node with it, so they don't create fake intersections.
- An **edge** is the stretch of a way between two nodes; undirected, with its length in metres (LV95).
- Node types: `dead_end` (degree 1), `junction` (2), `intersection` (3+).
- **Connected components** by union-find. Component 0, the main network (14,258 nodes), is the one that gets costs, routes and a cost space; 101 small disconnected pieces are only drawn, faded.

### 4.2 Joining data onto edges (`join_*_edges.py`)

All joins sample each edge along its geometry and aggregate per edge:

| Data | Sampling | Per edge |
|---|---|---|
| PET raster | every 1 m, raster cell lookup (NoData ignored) | mean PET, mean of max(PET − 29 °C, 0)² |
| Trees | every 1 m, shapely STRtree "within distance" query | share of samples within 6 m of a tree (9 m from street centrelines, which run ~3 m from the sidewalk) |
| Fountains | every 1 m, STRtree | share of samples within 100 m of a fountain; nearest fountain |
| Terrain | every 5 m, bilinear interpolation of the 2 m model | mean and max \|gradient\|, mean of exp(3.5 · \|gradient\|) − 1 |

Averaging per sample (not per edge) matters for non-linear terms: a half-sunny, half-shaded edge keeps the cost of its sunny half. Edges without a PET sample take the mean of their neighbours (spread over up to 10 rounds, then the median).

**Bridges and tunnels** for slope: the terrain model has neither, so connected OSM ways tagged `bridge` or `tunnel` are merged into one structure and the height is interpolated linearly between its ends. A bridge end takes the highest terrain within 10 m (the top of the bank). Only edges on the structure and points within 3 m of its ends are interpolated, so streets passing under a bridge keep the terrain.

### 4.3 Cost model (`cost_model.py`)

```
cost   = length × slope × (1 + heat_excess × relief / scale²)
slope  = 1 + weight × slope_excess                         weight: 0.5 / 1 / 2 by profile
relief = (1 − 0.5 × shade_share) × (1 − 0.2 × fountain_share)
```

`scale` per profile is 16 / 12 / 8 °C (low / medium / high); the reasoning behind each term is in the README. Each factor can be switched off (then its term is 1). The pipeline stores the ingredients (`edge_heat`), not finished costs, so the browser can compute any combination itself.

### 4.4 Colours and the fixed reference

Each street is coloured by its cost per metre divided by the **reference**: the length-weighted median cost per metre of the whole network without trees, fountains and slope, per profile (1.41 / 1.73 / 2.65). The scale runs from 0.6× (teal) through 1× (grey) to 1.6× (red). Because the reference stays fixed, switching trees on visibly cools streets down instead of the scale moving along. The map evaluates the formula as a MapLibre expression on the GeoJSON properties; deck.gl uses the same stops in `colors.ts`.

### 4.5 Factors on the map

Switched-on factors are drawn in the geographic view with the toggle buttons' own symbols: the SVG paths are shared (`components/Icons.tsx`), drawn onto a coloured badge with Canvas `Path2D` and handed to MapLibre whenever a style asks for them (`styleimagemissing`), so they survive theme changes. Trees and fountains come from `/api/graph/factors`. All factor icons appear from zoom 16.5 (`ICON_MIN_ZOOM` in `map/style.ts`), trees as dots from zoom 14 before that; MapLibre hides overlapping icons. Steep streets (mean gradient ≥ 6 %) get an icon at their middle (`symbol-placement: line-center`) on the edge layer itself, so no extra data is needed.

### 4.6 Cost space: diffusion cartogram (`build_layout.py`, `cartogram.py`)

The cost space is a **density-equalising cartogram** (Gastner & Newman 2004):

1. **Density field.** On a 512 × 512 grid of 50 m cells (25.6 km, a wide neutral margin around Basel), every edge adds its length × log(cost per metre ÷ reference) at its midpoint. Both are blurred with a Gaussian (σ = 125 m) and divided, giving the local log-ratio; where the network is sparse it fades to 0, so rivers and parks keep their size. The target density is exp(exaggeration × log-ratio) = ratio^exaggeration.
2. **Diffusion.** The density diffuses towards its mean, solved spectrally with FFTs. Every grid node moves with the velocity v = −∇ρ / ρ, integrated with an adaptive midpoint (RK2) scheme until the density is uniform. Areas with high density expand, low density contracts; the flow is smooth, so **lines never cross** (checked: no folded cell in any warp).
3. **Storage.** The moved grid nodes, thinned to 100 m and cropped to 3 km around the network, are the **warp** (`layout_warp`). Any point is moved by bilinear interpolation, which the API applies to every street vertex, river, label, grid line and cell.

`EXAGGERATION` (in `build_layout.py`, 4) sets how strongly cost differences turn into area. One warp is computed per profile and factor combination (3 × 8 = 24, ~8 minutes).

In the browser, the slider interpolates every vertex linearly between map position (0) and warped position (1). When the profile or a factor changes, the new warp is blended in from the old one over 0.9 s. The 250 m cells are coloured with the street colour of the cost ratio their area stands for (area^(1/exaggeration)), so size and colour always agree.

### 4.7 Shortest and coolest route (`api/routing.py`)

- Start and destination clicks are **snapped** to the nearest node of the main network (equirectangular distance, at most 300 m away).
- **Dijkstra** with a binary heap (`heapq`) on the undirected adjacency list, run twice: weight = length for the shortest route, weight = walking cost (formula above, with the chosen profile and factors) for the coolest. ~14k nodes, 50–100 ms per comparison.
- The route geometry is the concatenation of the edges' coordinates, each reversed when walked from target to source.
- Reported per route: length, walking time at 1.3 m/s, walking cost and shade share. The panel compares the extra strain (cost − length) of both routes.
- Uphill and downhill cost the same by design, so routes are symmetric.

### 4.8 Backend caching

The API keeps the graph and pre-serialised GeoJSON in memory. Cost-space payloads (~4 MB each) are built from the stored warp on first request (~1 s) and cached; after startup, a background thread builds all 24 so switching is instant. `POST /api/graph/reload` re-reads the database after a pipeline run.

### 4.9 How correctness was checked

- Browser formula vs pipeline formula: identical over hundreds of random cases.
- Map colours (MapLibre expression) vs cost-space colours: identical to within half a colour step, all 48 styles validated with MapLibre's style spec.
- Routes: compared with an independent Dijkstra (scipy) on random start/end pairs and factor combinations.
- Cartograms: no folded cell in any warp; areas reach their target to within a few percent.
- Joins: brute-force distance checks, spot checks on known streets (flat and steep streets, bridges, shaded streets).

## 5. The heat data: PET

### What PET is

PET (physiologically equivalent temperature, VDI 3787) is a "felt temperature" in °C: the air temperature of a typical indoor room in which a person would feel the same heat stress as outdoors. It combines everything that makes heat stressful, for a standard person (sex, age, clothing, light activity):

- **air temperature**,
- **mean radiant temperature**: direct and reflected sunshine and the heat radiated by warm surfaces (asphalt, facades). This is why sun versus shade makes such a large difference,
- **wind speed**,
- **humidity** (water vapour pressure).

| PET | Heat stress (VDI 3787) |
|---|---|
| 18–23 °C | none |
| 23–29 °C | slight |
| 29–35 °C | moderate |
| 35–41 °C | strong |
| > 41 °C | extreme |

The cost model starts counting at 29 °C, where moderate heat stress begins.

### What the Basel data is

The rasters come from the canton's **urban climate analysis (Klimaanalyse Basel-Stadt, 2019)**, which modelled the climate of the whole canton **today and for 2030**, on an **average summer day at 14:00** (and at night, 04:00; not used here). Published on [geo.bs.ch/stadtklima](https://www.geo.bs.ch/stadtklima).

| Property | Value |
|---|---|
| Files | `HumanbioklimSituation.tif` (today), `HumanbioklimSituation_2030.tif` |
| Grid | 1,248 × 999 cells of 10 × 10 m, LV95 (from the world file; no CRS in the file) |
| Values | PET in °C, float32; today 19–48 °C, median 37.8 °C; 2030 median 39.8 °C (+2 °C) |
| NoData | −9999, 10.5 % of cells, most likely building footprints (PET isn't defined inside buildings) |
| Along the walkable network | mean 38.8 °C: on a typical summer afternoon, most streets are in strong heat stress |

### What is "hidden" in a PET value

PET is the output of a numerical urban climate model, not a measurement. Such models typically take terrain, land use, surface sealing, building and tree heights and water bodies as input, and simulate radiation, shading, air temperature and wind for a calm, sunny high-pressure day. So each 10 m cell already reflects:

- **shade from buildings** (narrow streets and north sides are cooler),
- **the surface**: sealed asphalt and stone heat up, grass and soil stay cooler. Our data confirms this clearly: unsealed paths (gravel, grass, soil) are 7–13 °C cooler in PET than asphalt (median 39.2 °C). That's why surface cover is not an extra cost factor,
- **vegetation**, to the extent it is in the model's input. Here the data shows something interesting: streets lined with cadastre trees are at most ~2 °C cooler in PET, so street trees are only partly reflected. That's why tree shade is added as its own factor, with a moderate effect,
- **water and air flow**: the Rhine and cool-air corridors.

Not in PET: **slope** (it's about effort, not climate), **fountains** (a point to cool down, below the 10 m scale), the time spent walking, and individual sensitivity. These are what the other factors and the profiles add.

### Limits

- One moment (14:00) of one weather situation: it shows a typical hot afternoon, not every summer day or hour.
- 10 m cells: a sidewalk and the middle of the road can fall into the same cell.
- A model result: good for comparing places, not an exact temperature at a spot.
- The 2030 scenario is in the repo (`pet_2030_mean_c` in `edge_stadtklima`) but not used by the app yet.

Sources: [Kanton Basel-Stadt, Klimaanalyse 2019](https://www.bs.ch/medienmitteilungen/2019-klimaanalyse-kanton-basel-stadt-liegt-vor), [Grosser Rat Basel-Stadt, Klimaanalysen für die Zukunft von Basel (24.5034.01)](https://grosserrat.bs.ch/dokumente/100406/000000406556.pdf), [Geoportal Basel-Stadt, Stadtklima](https://www.geo.bs.ch/stadtklima).
