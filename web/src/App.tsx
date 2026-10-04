import { Suspense, lazy, useCallback, useEffect, useRef, useState } from "react";
import type { Map as MapLibreMap } from "maplibre-gl";
import {
  fetchCostSpace,
  fetchMeta,
  fetchRoute,
  type CostSpaceData,
  type GraphMeta,
  type NodeDetail,
  type RouteComparison,
} from "./api";
import { RouteSection, type RoutePicking } from "./components/RouteSection";
import type { Scheme } from "./map/basemap";
import { DEFAULT_PROFILE, type HeatProfile } from "./profiles";
import { ALL_FACTORS, factorsKey, type Factors } from "./costModel";
import { MapView, boundsOf, type Selection } from "./components/MapView";
import { Panel } from "./components/Panel";
import { InfoPopup } from "./components/InfoPopup";
import { Inspector } from "./components/Inspector";
import type { CostSpaceHandle } from "./components/CostSpaceView";
import { MorphSlider } from "./components/MorphSlider";
import { SegmentedControl } from "./components/SegmentedControl";
import { MinusIcon, MoonIcon, PlusIcon, RecenterIcon, SunIcon } from "./components/Icons";

type View = "geographic" | "cost-space";

const variantKey = (p: HeatProfile, r: Factors) => `${p}|${factorsKey(r)}`;

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
  const [error, setError] = useState<string | null>(null);
  const [graphLoaded, setGraphLoaded] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const [profile, setProfile] = useState<HeatProfile>(DEFAULT_PROFILE);
  const [factors, setFactors] = useState<Factors>(ALL_FACTORS);
  const [view, setView] = useState<View>("geographic");
  const [selection, setSelection] = useState<Selection>(null);

  // Route comparison: pick a start and a destination on the map
  const [picking, setPicking] = useState<RoutePicking>("off");
  const [routeEnds, setRouteEnds] = useState<{ start: [number, number]; end: [number, number] | null } | null>(
    null,
  );
  const [routes, setRoutes] = useState<RouteComparison | null>(null);
  const [routeLoading, setRouteLoading] = useState(false);
  const [routeError, setRouteError] = useState<string | null>(null);
  const pick = (lon: number, lat: number) => {
    if (picking === "start") {
      setRouteEnds({ start: [lon, lat], end: null });
      setRoutes(null);
      setRouteError(null);
      setPicking("end");
    } else if (picking === "end" && routeEnds) {
      setRouteEnds({ ...routeEnds, end: [lon, lat] });
      setPicking("off");
    }
  };
  const clearRoutes = () => {
    setPicking("off");
    setRouteEnds(null);
    setRoutes(null);
    setRouteError(null);
  };
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
  // One cost space per profile and factors, fetched once each
  const costCache = useRef(new Map<string, Promise<CostSpaceData>>());
  const variantRef = useRef(variantKey(profile, factors));
  variantRef.current = variantKey(profile, factors);
  const hasCostData = useRef(false);
  hasCostData.current = costData !== null;
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

  // Fetches (once per variant) and shows the cost space of a profile and factors
  const loadCostSpace = useCallback((p: HeatProfile, r: Factors) => {
    const key = variantKey(p, r);
    let request = costCache.current.get(key);
    if (!request) {
      request = fetchCostSpace(p, r);
      costCache.current.set(key, request);
      request.catch(() => costCache.current.delete(key));
    }
    setCostStatus("loading");
    request
      .then((d) => {
        if (variantRef.current !== key) return; // overtaken by a later switch
        setCostData(d);
        setCostStatus("idle");
      })
      .catch(() => {
        if (variantRef.current !== key) return;
        setCostStatus("error");
        // without any cost space to show, fall back to the map
        if (!hasCostData.current) setView("geographic");
      });
  }, []);
  const changeVariant = (p: HeatProfile, r: Factors) => {
    setProfile(p);
    setFactors(r);
    variantRef.current = variantKey(p, r);
    if (view === "cost-space") loadCostSpace(p, r);
  };
  const changeProfile = (next: HeatProfile) => next !== profile && changeVariant(next, factors);
  const changeFactors = (next: Factors) => changeVariant(profile, next);
  const shownVariant = costData
    ? variantKey(costData.meta.profile, {
        trees: costData.meta.trees,
        fountains: costData.meta.fountains,
        slope: costData.meta.slope,
      })
    : null;

  const switchView = (next: View) => {
    if (next === view) return;
    setView(next);
    if (next === "cost-space") {
      setPicking("off"); // picking only works on the map
      if (shownVariant !== variantKey(profile, factors)) loadCostSpace(profile, factors);
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
    fetchMeta(ctrl.signal)
      .then(setMeta)
      .catch((e: Error) => {
        if (e.name !== "AbortError") setError(e.message);
      });
    return () => ctrl.abort();
  }, []);

  // Routes for the picked points, again whenever the profile or factors changes
  useEffect(() => {
    if (!routeEnds?.end) return;
    const ctrl = new AbortController();
    setRouteLoading(true);
    setRouteError(null);
    fetchRoute(routeEnds.start, routeEnds.end, profile, factors, ctrl.signal)
      .then((r) => {
        setRoutes(r);
        setRouteLoading(false);
      })
      .catch((e: Error) => {
        if (e.name === "AbortError") return;
        setRoutes(null);
        setRouteError(e.message);
        setRouteLoading(false);
      });
    return () => ctrl.abort();
  }, [routeEnds, profile, factors]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setInfoOpen(false);
      setSelection(null);
      setPicking("off");
    };
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
      {meta && (
        <div className={`view-layer ${costVisible ? "hidden" : ""}`}>
          <MapView
          meta={meta}
          scheme={scheme}
          profile={profile}
          factors={factors}
          routes={routes}
          picking={picking !== "off"}
          onPick={pick}
          selection={selection}
          onSelect={select}
          onMap={(m) => (mapRef.current = m)}
          onGraphLoaded={() => setGraphLoaded(true)}
          />
        </div>
      )}

      {meta && costData && (
        <div className={`view-layer ${costVisible ? "" : "hidden"}`} aria-hidden={!costVisible}>
          <Suspense fallback={null}>
            <CostSpaceView
              ref={costRefCallback}
            data={costData}
            meta={meta}
            scheme={scheme}
              t={t}
              selection={selection}
              onSelect={select}
              routes={routes}
            />
          </Suspense>
        </div>
      )}

      {meta && (
        <Panel
          meta={meta}
          scheme={scheme}
          profile={profile}
          onProfileChange={changeProfile}
          factors={factors}
          onFactorsChange={changeFactors}
          infoOpen={infoOpen}
          onToggleInfo={() => setInfoOpen((o) => !o)}
        >
          <RouteSection
            scheme={scheme}
            picking={picking}
            onPick={() => setPicking(picking === "off" ? "start" : "off")}
            onClear={clearRoutes}
            canPick={view === "geographic" && !costVisible}
            routes={routes}
            loading={routeLoading}
            error={routeError}
          />
        </Panel>
      )}

      {meta && infoOpen && (
        <InfoPopup
          meta={meta}
          layout={view === "cost-space" ? (costData?.meta ?? null) : null}
          onClose={() => setInfoOpen(false)}
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

      {meta && selection && (
        <Inspector
          selection={selection}
          meta={meta}
          profile={profile}
          factors={factors}
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
