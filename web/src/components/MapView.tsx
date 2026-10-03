import { useEffect, useRef, useState } from "react";
import {
  AttributionControl,
  Map as MapLibreMap,
  setWorkerUrl,
  type MapGeoJSONFeature,
  type PointLike,
} from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import type { GraphMeta } from "../api";
import type { Scheme } from "../map/basemap";
import { buildStyle, categoryOf, type ColorMode } from "../map/style";
import { formatLength, formatLeverage } from "../format";
import type { HeatProfile } from "../profiles";

setWorkerUrl(workerUrl);

export type Selection = { kind: "node" | "edge"; id: number } | null;

interface Props {
  meta: GraphMeta;
  scheme: Scheme;
  profile: HeatProfile;
  mode: ColorMode;
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

export function MapView({
  meta,
  scheme,
  profile,
  mode,
  selection,
  onSelect,
  onMap,
  onGraphLoaded,
}: Props) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const [tooltip, setTooltip] = useState<Tooltip | null>(null);
  // Latest callbacks, so map event handlers registered once never go stale
  const handlers = useRef({ onSelect, onGraphLoaded, profile, mode });
  handlers.current = { onSelect, onGraphLoaded, profile, mode };

  // Create the map once
  useEffect(() => {
    const b = meta.bounds;
    const pad = 0.06;
    const map = new MapLibreMap({
      container: container.current!,
      style: buildStyle(scheme, profile, mode),
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

    map.on("mousemove", (e) => {
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
              detail: [
                handlers.current.mode === "leverage" &&
                  (formatLeverage(p[`leverage_pct_${handlers.current.profile}`]) ?? "little shade benefit"),
                `${formatLength(p[`walk_cost_m_${handlers.current.profile}`])} cost`,
                formatLength(p.length_m),
                p.highway.replace("_", " "),
              ]
                .filter(Boolean)
                .join(" · "),
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

  // Restyle on theme, heat profile or colour mode change (MapLibre diffs the styles).
  // Skipped for the style the map was created with.
  const styleKey = useRef(`${scheme}|${profile}|${mode}`);
  useEffect(() => {
    const key = `${scheme}|${profile}|${mode}`;
    if (key === styleKey.current) return;
    styleKey.current = key;
    mapRef.current?.setStyle(buildStyle(scheme, profile, mode));
  }, [scheme, profile, mode]);

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
