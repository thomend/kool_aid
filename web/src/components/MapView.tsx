import { useEffect, useRef, useState } from "react";
import {
  AttributionControl,
  Map as MapLibreMap,
  setWorkerUrl,
  type GeoJSONSource,
  type MapGeoJSONFeature,
  type PointLike,
} from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import type { GraphMeta, RouteComparison } from "../api";
import type { Scheme } from "../map/basemap";
import { FACTOR_LAYERS, ROUTE_POINTS_SOURCE, ROUTE_SOURCE, buildStyle, categoryOf } from "../map/style";
import { factorIcon } from "../map/icons";
import { formatHeatRatio, formatLength } from "../format";
import type { HeatProfile } from "../profiles";
import { costFactor, referenceMedian, factorsKey, type Factors } from "../costModel";

setWorkerUrl(workerUrl);

export type Selection = { kind: "node" | "edge"; id: number } | null;

interface Props {
  meta: GraphMeta;
  scheme: Scheme;
  profile: HeatProfile;
  factors: Factors;
  /** Route comparison to draw, if any. */
  routes: RouteComparison | null;
  /** Picking route points: clicks report a location instead of selecting. */
  picking: boolean;
  onPick: (lon: number, lat: number) => void;
  selection: Selection;
  onSelect: (s: Selection) => void;
  onMap: (map: MapLibreMap) => void;
  onGraphLoaded: () => void;
}

interface Tooltip {
  x: number;
  y: number;
  title: string;
  detail: string;
}

const SOURCE = { node: "graph-nodes", edge: "graph-edges" } as const;

export function boundsOf(meta: GraphMeta): [[number, number], [number, number]] {
  const b = meta.bounds;
  return [
    [b.west, b.south],
    [b.east, b.north],
  ];
}

// Tooltip line for an edge feature's (flat) properties
function edgeDetail(p: Record<string, any>, profile: HeatProfile, factors: Factors, meta: GraphMeta): string {
  const model = meta.cost_model;
  if (!model || p.heat_excess_sq_mean === undefined) {
    return `${formatLength(p.length_m)} · ${p.highway.replace("_", " ")}`;
  }
  const factor = costFactor(
    model,
    profile,
    factors,
    p.heat_excess_sq_mean,
    p.shade_share,
    p.fountain_share,
    p.slope_excess,
  );
  return [
    `${formatLength(p.length_m * factor)} cost`,
    formatHeatRatio(factor, referenceMedian(model, profile)),
    ...(factors.slope && p.grade_mean >= 0.02 ? [`${Math.round(p.grade_mean * 100)} % gradient`] : []),
    p.highway.replace("_", " "),
  ].join(" · ");
}

// Tooltip of a tree or fountain on the map
function factorTooltip(p: Record<string, any>): { title: string; detail: string } {
  if (p.kind === "fountain") return { title: p.name ?? "Fountain", detail: "Fountain" };
  return { title: p.species ?? "Tree", detail: p.age ? `Public tree, ${p.age} years old` : "Public tree" };
}

export function MapView({
  meta,
  scheme,
  profile,
  factors,
  routes,
  picking,
  onPick,
  selection,
  onSelect,
  onMap,
  onGraphLoaded,
}: Props) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const [tooltip, setTooltip] = useState<Tooltip | null>(null);
  // Latest callbacks, so map event handlers registered once never go stale
  const handlers = useRef({ onSelect, onGraphLoaded, onPick, picking, profile, factors, meta });
  handlers.current = { onSelect, onGraphLoaded, onPick, picking, profile, factors, meta };

  // Create the map once
  useEffect(() => {
    const b = meta.bounds;
    const pad = 0.06;
    const map = new MapLibreMap({
      container: container.current!,
      style: buildStyle(scheme, meta.cost_model, profile, factors),
      bounds: boundsOf(meta),
      fitBoundsOptions: { padding: 40 },
      maxBounds: [
        [b.west - pad, b.south - pad],
        [b.east + pad, b.north + pad],
      ],
      minZoom: 11,
      maxZoom: 19.5,
      attributionControl: false,
      dragRotate: false,
      pitchWithRotate: false,
    });
    map.touchZoomRotate.disableRotation();
    // The tile source brings its own attribution (OpenFreeMap, OpenMapTiles, OSM),
    // which also covers the graph data. Start collapsed to the (i) button.
    map.addControl(new AttributionControl({ compact: true }), "bottom-right");
    map.once("load", () =>
      container.current
        ?.querySelector(".maplibregl-ctrl-attrib")
        ?.classList.remove("maplibregl-compact-show"),
    );
    mapRef.current = map;
    onMap(map);

    let hovered: MapGeoJSONFeature | null = null;
    const setHover = (f: MapGeoJSONFeature | null) => {
      if (hovered?.id === f?.id && hovered?.source === f?.source) return;
      if (hovered) map.setFeatureState({ source: hovered.source, id: hovered.id! }, { hover: false });
      hovered = f;
      if (f) map.setFeatureState({ source: f.source, id: f.id! }, { hover: true });
    };

    const featureAt = (point: { x: number; y: number }) => {
      const box = (r: number): [PointLike, PointLike] => [
        [point.x - r, point.y - r],
        [point.x + r, point.y + r],
      ];
      const layers = ["nodes", "edges"].filter((l) => map.getLayer(l));
      const nodes = layers.includes("nodes")
        ? map.queryRenderedFeatures(box(7), { layers: ["nodes"] })
        : [];
      if (nodes.length) return nodes[0];
      return map.queryRenderedFeatures(box(5), { layers: ["edges"] })[0] ?? null;
    };

    // trees and fountains (the visible ones), for their tooltip
    const factorAt = (point: { x: number; y: number }) => {
      const layers = FACTOR_LAYERS.filter(
        (l) => map.getLayer(l) && map.getLayoutProperty(l, "visibility") !== "none",
      );
      if (!layers.length) return null;
      const box: [PointLike, PointLike] = [
        [point.x - 8, point.y - 8],
        [point.x + 8, point.y + 8],
      ];
      return map.queryRenderedFeatures(box, { layers })[0] ?? null;
    };

    // factor icons are drawn on demand, also after a restyle
    map.on("styleimagemissing", (e) => {
      const icon = factorIcon(e.id);
      if (icon && !map.hasImage(e.id)) map.addImage(e.id, icon.image, { pixelRatio: icon.pixelRatio });
    });

    map.on("mousemove", (e) => {
      if (handlers.current.picking) {
        // picking route points: no hover or tooltip, just a crosshair
        setHover(null);
        setTooltip(null);
        map.getCanvas().style.cursor = "crosshair";
        return;
      }
      const point = factorAt(e.point);
      if (point) {
        setHover(null);
        map.getCanvas().style.cursor = "";
        return setTooltip({ x: e.point.x, y: e.point.y, ...factorTooltip(point.properties) });
      }
      const f = featureAt(e.point);
      setHover(f);
      map.getCanvas().style.cursor = f ? "pointer" : "";
      if (!f) return setTooltip(null);
      const p = f.properties;
      setTooltip(
        f.source === SOURCE.edge
          ? {
              x: e.point.x,
              y: e.point.y,
              title: p.street_name ?? categoryOf(p.highway).label,
              detail: edgeDetail(p, handlers.current.profile, handlers.current.factors, handlers.current.meta),
            }
          : {
              x: e.point.x,
              y: e.point.y,
              title: p.node_type === "dead_end" ? "Dead end" : "Intersection",
              detail: `${p.degree} connecting ${p.degree === 1 ? "edge" : "edges"}`,
            },
      );
    });
    map.on("mouseout", () => {
      setHover(null);
      setTooltip(null);
    });
    map.on("movestart", () => setTooltip(null));
    map.on("click", (e) => {
      if (handlers.current.picking) {
        handlers.current.onPick(e.lngLat.lng, e.lngLat.lat);
        return;
      }
      const f = featureAt(e.point);
      handlers.current.onSelect(
        f ? { kind: f.source === SOURCE.node ? "node" : "edge", id: Number(f.id) } : null,
      );
    });
    map.on("sourcedata", (e) => {
      if (e.sourceId === SOURCE.edge && e.isSourceLoaded) handlers.current.onGraphLoaded();
    });

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // Restyle on theme / heat profile / factors change (MapLibre diffs the styles).
  // Skipped for the style the map was created with.
  const key = `${scheme}|${profile}|${factorsKey(factors)}`;
  const styleKey = useRef(key);
  useEffect(() => {
    if (key === styleKey.current) return;
    styleKey.current = key;
    mapRef.current?.setStyle(buildStyle(scheme, meta.cost_model, profile, factors));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, meta]);

  // Draw the route comparison (also after a restyle)
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const apply = () => {
      const lines = map.getSource(ROUTE_SOURCE) as GeoJSONSource | undefined;
      const points = map.getSource(ROUTE_POINTS_SOURCE) as GeoJSONSource | undefined;
      lines?.setData({
        type: "FeatureCollection",
        // shortest first, so the coolest route is drawn on top where they overlap
        features: routes
          ? (["shortest", "coolest"] as const).map((kind) => ({
              type: "Feature",
              geometry: { type: "LineString", coordinates: routes[kind].coordinates },
              properties: { kind },
            }))
          : [],
      });
      points?.setData({
        type: "FeatureCollection",
        features: routes
          ? (["start", "end"] as const).map((kind) => ({
              type: "Feature",
              geometry: { type: "Point", coordinates: [routes[kind].lon, routes[kind].lat] },
              properties: { kind },
            }))
          : [],
      });
    };
    if (map.getSource(ROUTE_SOURCE)) apply();
    else map.once("styledata", apply);
  }, [routes, key]);

  // Picking: crosshair right away, not only after the next mouse move
  useEffect(() => {
    const canvas = mapRef.current?.getCanvas();
    if (canvas) canvas.style.cursor = picking ? "crosshair" : "";
  }, [picking]);

  // Reflect the selection as feature-state
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !selection) return;
    const target = { source: SOURCE[selection.kind], id: selection.id };
    const apply = () => map.setFeatureState(target, { selected: true });
    if (map.getSource(target.source)) apply();
    else map.once("load", apply);
    return () => {
      if (map.getSource(target.source)) map.setFeatureState(target, { selected: false });
    };
  }, [selection]);

  return (
    <div className="map-wrap">
      <div ref={container} className="map" />
      {tooltip && (
        <div className="tooltip glass" style={{ left: tooltip.x, top: tooltip.y }}>
          <div className="tooltip-title">{tooltip.title}</div>
          <div className="tooltip-detail">{tooltip.detail}</div>
        </div>
      )}
    </div>
  );
}
