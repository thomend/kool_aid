# Walkable Basel

Team Kool Aid's project for the hackamrhein challenge: **where would shade help people on foot most?**

## Initial situation

Basel's summers are getting hotter. On a hot afternoon most of the city's streets reach strong to extreme heat stress (PET above 35 °C), and by 2030 that share grows further. The canton already has a heat map (Stadtklimaanalyse), but a heat map only shows *where it is hot*, not *where heat actually hurts people on foot*: a hot square few people cross matters less than a moderately hot link many walks depend on, and a hot street with a shaded street next to it matters less than one with no way around.

## Goal

Show which streets are hot **and** hard to avoid on everyday walks, so that shading them (trees, awnings, arcades) removes the most heat from the most walks.

## Who it is for

Urban planners and decision makers who need to prioritise where to invest in shade, and anyone who wants to understand how heat shapes walking in Basel.

## How we achieve it

1. **Network:** Basel's walkable ways become a graph of nodes (intersections, dead ends) and edges (the path sections between them).
2. **Heat per edge:** every edge gets the felt temperature (PET) from the canton's climate model, sampled every metre.
3. **Walking cost:** each edge's length is stretched by heat stress, for three heat-sensitivity profiles.
4. **Shade priority:** ~4.2 million simulated walks (up to 2 km between random points) take their coolest route. An edge's priority is the heat that still remains on it, summed over all walks that cannot avoid it: the heat shading it would remove.

The web app shows this as:

- **Shade priority** (start view): edges coloured by priority, with a ranking of the top streets.
- **Walking cost**: edges coloured by heat factor, the cost of each metre.
- **Cost space**: the network redrawn so every edge is as long as its cost; hot streets push the city apart. An illustration, not an analysis.

Click any edge for details. The glossary (book icon) explains everything in the app.

## How costs are calculated

```
cost = length × mean over 1 m samples of (1 + (max(PET − 29 °C, 0) / scale)²)
```

- Up to **29 °C PET** (at most slight heat stress, VDI 3787) a metre costs a metre.
- Above it, cost grows **quadratically**, so extreme heat is disproportionately expensive.
- **Heat sensitivity** sets `scale`: low 16 °C, medium 12 °C, high 8 °C. At 41 °C (extreme heat stress) a metre costs 1.6, 2 or 3.3 metres.

Shade priority builds on this:

```
priority (leverage) = (cost − length) × walks whose coolest route uses the edge ÷ all walks
```

**Limits:** PET describes 14:00 on a hot, cloudless day (a worst case). The profiles are assumptions and weigh heat more than observed behaviour (people treat a sunny metre as ~1.16 shaded metres, Melnikov et al. 2022). Walks are simulated, not counted, so stations or schools carry no extra weight.

## Where the data comes from

| Data | Source | Licence |
|---|---|---|
| Walkable ways, rivers, districts | [OpenStreetMap](https://www.openstreetmap.org) (Overpass API) | ODbL |
| PET at 14:00, today and 2030, 10 m | [Stadtklimaanalyse Basel-Stadt](https://map.geo.bs.ch/file_proxy/KL_Stadtklima_Windstroemungsfeld/Endbericht_Basel_Klimaanalyse_Rev09_ohne_Anhang.pdf) (GEO-NET 2019), files in `data/KL_Stadtklima_*` | [Terms of use, geodata Basel-Stadt](https://shop.geo.bs.ch/geodaten-katalog/) |
| Tree cadastre (in the database, not used yet) | [data.bs.ch 100052](https://data.bs.ch/explore/dataset/100052/), Stadtgärtnerei | CC BY 4.0 |
| Basemap | [OpenFreeMap](https://openfreemap.org) | OSM data |

## Run it

Everything runs in the devcontainer. The prepared database `data/basel.duckdb` is in the repo.

```bash
fastapi dev api/app.py --host 0.0.0.0 --port 8050   # API
cd web && npm install && npm run dev                  # app on http://localhost:5173
```

**Rebuild the data** (only after changing a script; run from the repo root, in this order):

```bash
python scripts/fetch_paths.py                       # OSM ways             -> paths
python scripts/fetch_context.py                     # rivers, districts    -> context_lines, context_labels
python scripts/build_graph.py                       # nodes and edges      -> nodes, edges, node_paths
python scripts/join_stadtklima_edges.py --replace   # PET per edge         -> edge_stadtklima
python scripts/join_trees_edges.py --replace        # trees per edge       -> trees, edge_trees
python scripts/build_layout.py                      # costs + cost space   -> edge_cost, node_layout, layout_meta
python scripts/build_leverage.py --replace          # shade priority       -> edge_leverage, leverage_meta
curl -X POST localhost:8050/api/graph/reload        # if the API is running
```

| Folder | Content |
|---|---|
| `scripts/` | Data pipeline into DuckDB |
| `data/` | `basel.duckdb` (Git LFS, cannot be merged: pulling replaces your copy) and the PET rasters |
| `api/` | FastAPI backend, serves the data under `/api` (docs at http://localhost:8050/docs) |
| `web/` | React app: MapLibre for the map, deck.gl for the cost space |

## References

- GEO-NET (2019). *Stadtklimaanalyse Kanton Basel-Stadt.* Kanton Basel-Stadt.
- VDI 3787 Blatt 2 (2008). PET thresholds for heat stress.
- Melnikov, V. R. et al. (2022). Behavioural thermal regulation explains pedestrian path choices in hot urban environments. *Scientific Reports* 12, 2441.
- Wolf, H., Vierø, A. R. & Szell, M. (2025). CoolWalks for active mobility in urban street networks. *Scientific Reports* 15, 14911.
- Gansner, E. R., Koren, Y. & North, S. (2004). Graph drawing by stress majorization. *Graph Drawing 2004*, LNCS 3383.
