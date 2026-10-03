import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Map as MapLibreMap } from "maplibre-gl";
import {
  fetchCostModel,
  fetchCostSpace,
  fetchEdgeFactors,
  fetchMeta,
  type CostModel,
  type CostSpaceData,
  type EdgeFactors,
  type GraphMeta,
  type NodeDetail,
} from "./api";
import { evaluateCosts, settingsFromFunction, type CostSettings } from "./cost";
import { useLiveLayout } from "./costLayout";
import type { Scheme } from "./map/basemap";
import type { ColorMode } from "./map/style";
import { MapView, boundsOf, type Selection } from "./components/MapView";
import { Panel } from "./components/Panel";
import { Inspector } from "./components/Inspector";
import type { CostSpaceHandle } from "./components/CostSpaceView";
import { MorphSlider } from "./components/MorphSlider";
import { SegmentedControl } from "./components/SegmentedControl";
import { MinusIcon, MoonIcon, PlusIcon, RecenterIcon, SunIcon } from "./components/Icons";

type View = "geographic" | "cost-space";

// deck.gl is only needed for the cost-space view, so load it on demand
const CostSpaceView = lazy(() =>
  import("./components/CostSpaceView").then((m) => ({ default: m.CostSpaceView })),
);

const easeInOutCubic = (k: number) => (k < 0.5 ? 4 * k ** 3 : 1 - (-2 * k + 2) ** 3 / 2);

function useSystemScheme(): Scheme {
  const query = "(prefers-color-scheme: dark)";
  const [dark, setDark] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mql = window.matchMedia(query);
    const listener = (e: MediaQueryListEvent) => setDark(e.matches);
    mql.addEventListener("change", listener);
    return () => mql.removeEventListener("change", listener);
  }, []);
  return dark ? "dark" : "light";
}

export default function App() {
  const systemScheme = useSystemScheme();
  const [schemeOverride, setSchemeOverride] = useState<Scheme | null>(null);
  const scheme = schemeOverride ?? systemScheme;

  const [meta, setMeta] = useState<GraphMeta | null>(null);
  const [costModel, setCostModel] = useState<CostModel | null>(null);
  const [edgeFactors, setEdgeFactors] = useState<EdgeFactors | null>(null);
  const [costSettings, setCostSettings] = useState<CostSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [graphLoaded, setGraphLoaded] = useState(false);
  const [mode, setMode] = useState<ColorMode>("cost");
  const [view, setView] = useState<View>("geographic");
  const [selection, setSelection] = useState<Selection>(null);
  const focusNext = useRef(false);
  const mapRef = useRef<MapLibreMap | null>(null);

  // Cost space: data is fetched on first use; `t` morphs geography (0) → cost (1)
  const costRef = useRef<CostSpaceHandle | null>(null);
  const [costReady, setCostReady] = useState(false);
  const costRefCallback = useCallback((handle: CostSpaceHandle | null) => {
    costRef.current = handle;
    setCostReady(handle !== null);
  }, []);
  const [costData, setCostData] = useState<CostSpaceData | null>(null);
  const [costStatus, setCostStatus] = useState<"idle" | "loading" | "error">("idle");
  const [costVisible, setCostVisible] = useState(false);
  const [t, setT] = useState(0);
  const tRef = useRef(0);
  const animation = useRef<number | null>(null);

  const setMorph = useCallback((value: number) => {
    tRef.current = value;
    setT(value);
  }, []);

  const animateMorph = useCallback(
    (to: number, duration: number, done?: () => void) => {
      if (animation.current) cancelAnimationFrame(animation.current);
      const from = tRef.current;
      const start = performance.now();
      const step = (now: number) => {
        const k = Math.min(1, (now - start) / (duration * Math.abs(to - from) || 1));
        setMorph(from + (to - from) * easeInOutCubic(k));
        if (k < 1) animation.current = requestAnimationFrame(step);
        else {
          animation.current = null;
          done?.();
        }
      };
      animation.current = requestAnimationFrame(step);
    },
    [setMorph],
  );

  const switchView = (next: View) => {
    if (next === view) return;
    setView(next);
    if (next === "cost-space") {
      if (!costData && costStatus !== "loading") {
        setCostStatus("loading");
        fetchCostSpace()
          .then((d) => {
            setCostData(d);
            setCostStatus("idle");
          })
          .catch(() => {
            setCostStatus("error");
            setView("geographic");
          });
      }
      return; // entering happens in the effect below, once the view is mounted
    }
    // Back to geography: unmorph, then hand the camera over to the map
    animateMorph(0, 900, () => {
      const cam = costRef.current?.getCamera();
      if (cam) mapRef.current?.jumpTo({ center: cam.center, zoom: cam.mapZoom });
      setCostVisible(false);
    });
  };

  useEffect(() => {
    if (view !== "cost-space" || !costReady || costVisible) return;
    const map = mapRef.current;
    if (map) {
      const c = map.getCenter();
      costRef.current?.setCamera([c.lng, c.lat], map.getZoom());
    }
    setCostVisible(true);
    animateMorph(1, 1400);
  }, [view, costReady, costVisible, animateMorph]);

  // Zoom / reset buttons drive whichever view is showing
  const controller = costVisible
    ? {
        zoomIn: () => costRef.current?.zoomIn(),
        zoomOut: () => costRef.current?.zoomOut(),
        fitAll: () => costRef.current?.fitAll(),
      }
    : {
        zoomIn: () => mapRef.current?.zoomIn(),
        zoomOut: () => mapRef.current?.zoomOut(),
        fitAll: () => meta && mapRef.current?.fitBounds(boundsOf(meta), { padding: 40, duration: 900 }),
      };

  useEffect(() => {
    document.documentElement.dataset.theme = scheme;
  }, [scheme]);

  useEffect(() => {
    const ctrl = new AbortController();
    Promise.all([fetchMeta(ctrl.signal), fetchCostModel(ctrl.signal), fetchEdgeFactors(ctrl.signal)])
      .then(([m, model, factors]) => {
        setMeta(m);
        setCostModel(model);
        setEdgeFactors(factors);
        setCostSettings(settingsFromFunction(model, model.default_function));
      })
      .catch((e: Error) => {
        if (e.name !== "AbortError") setError(e.message);
      });
    return () => ctrl.abort();
  }, []);

  // Edge costs for the current settings, evaluated in the browser
  const costs = useMemo(
    () =>
      costModel && edgeFactors && costSettings
        ? evaluateCosts(costModel, edgeFactors, costSettings)
        : null,
    [costModel, edgeFactors, costSettings],
  );
  // Cost-space layout, recomputed live in a Web Worker when the costs change
  const liveLayout = useLiveLayout(costData, costs);


  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setSelection(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const select = useCallback((s: Selection, focus = false) => {
    focusNext.current = focus;
    setSelection(s);
  }, []);

  // When a node is picked from the inspector, bring it into view
  const onNodeLoaded = useCallback(
    (node: NodeDetail) => {
      if (!focusNext.current) return;
      focusNext.current = false;
      if (costVisible) {
        const zoom = costRef.current?.getCamera().mapZoom ?? 16.5;
        costRef.current?.focus(node.lon, node.lat, Math.max(zoom, 16.5));
        return;
      }
      const map = mapRef.current;
      if (map && (!map.getBounds().contains([node.lon, node.lat]) || map.getZoom() < 15)) {
        map.easeTo({ center: [node.lon, node.lat], zoom: Math.max(map.getZoom(), 16.5), duration: 800 });
      }
    },
    [costVisible],
  );

  if (error) {
    return (
      <div className="center-screen">
        <div className="glass message">
          <h2>Can’t reach the API</h2>
          <p className="subtle">
            Start it with <code>fastapi dev api/app.py --port 8050</code> and reload.
          </p>
          <p className="subtle small mono">{error}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      {meta && costs && (
        <div className={`view-layer ${costVisible ? "hidden" : ""}`}>
          <MapView
            meta={meta}
            costs={costs}
            scheme={scheme}
            mode={mode}
            selection={selection}
            onSelect={select}
            onMap={(m) => (mapRef.current = m)}
            onGraphLoaded={() => setGraphLoaded(true)}
          />
        </div>
      )}

      {costs && costData && liveLayout.positions && (
        <div className={`view-layer ${costVisible ? "" : "hidden"}`} aria-hidden={!costVisible}>
          <Suspense fallback={null}>
            <CostSpaceView
              ref={costRefCallback}
              data={costData}
              costs={costs}
              positions={liveLayout.positions}
              costScale={liveLayout.costScale}
              scheme={scheme}
              mode={mode}
              t={t}
              selection={selection}
              onSelect={select}
            />
          </Suspense>
        </div>
      )}

      {meta && costModel && costs && costSettings && (
        <Panel
          meta={meta}
          scheme={scheme}
          mode={mode}
          onModeChange={setMode}
          costModel={costModel}
          costs={costs}
          settings={costSettings}
          onSettingsChange={setCostSettings}
          layout={view === "cost-space" ? liveLayout : null}
        />
      )}

      <div className="view-switch glass">
        <SegmentedControl
          label="View"
          value={view}
          onChange={switchView}
          options={[
            { value: "geographic", label: "Geographic" },
            { value: "cost-space", label: "Cost space" },
          ]}
        />
      </div>

      <div className="controls">
        <div className="glass control-group">
          <button className="icon-button" aria-label="Zoom in" onClick={controller.zoomIn}>
            <PlusIcon />
          </button>
          <span className="divider" />
          <button className="icon-button" aria-label="Zoom out" onClick={controller.zoomOut}>
            <MinusIcon />
          </button>
        </div>
        <button
          className="glass icon-button solo"
          aria-label="Show all of Basel"
          onClick={controller.fitAll}
        >
          <RecenterIcon />
        </button>
        <button
          className="glass icon-button solo"
          aria-label={scheme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
          onClick={() => setSchemeOverride(scheme === "dark" ? "light" : "dark")}
        >
          {scheme === "dark" ? <SunIcon /> : <MoonIcon />}
        </button>
      </div>

      {selection && costs && (
        <Inspector
          selection={selection}
          scheme={scheme}
          costs={costs}
          onSelect={select}
          onNodeLoaded={onNodeLoaded}
        />
      )}

      {costVisible && view === "cost-space" && (
        <MorphSlider
          value={t}
          onChange={(v) => {
            if (animation.current) cancelAnimationFrame(animation.current);
            animation.current = null;
            setMorph(v);
          }}
        />
      )}

      {(!graphLoaded || costStatus === "loading") && (
        <div className="loading glass" role="status">
          <span className="spinner" aria-hidden />
          {graphLoaded ? "Loading cost space…" : "Loading walkable network…"}
        </div>
      )}

      {costStatus === "error" && (
        <div className="loading glass" role="alert">
          Cost space unavailable. Run <code>scripts/build_layout.py</code>.
        </div>
      )}
    </div>
  );
}
