/**
 * Mounts the USD engine into a plain div, exactly as ViewerCanvas does for IFC.
 *
 * The engine owns a render loop and long-lived three.js objects; React only
 * receives status callbacks. The component never re-creates the engine for a
 * state change, and unmounting disposes it with the div.
 */
import { useEffect, useRef } from "react";

import { useUsdStore } from "@/store/usdStore";
import { UsdEngine } from "@/viewer/usdEngine";
import { transformFromParams } from "@/viewer/splatLayer";

export function UsdCanvas() {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const store = useUsdStore.getState();
    const engine = new UsdEngine({
      onProgress: (detail) => useUsdStore.getState().setLoading(detail),
      onReady: ({ meshCount, layers }) => {
        const manifest = engine.manifestForUi;
        useUsdStore.getState().setReady({
          meshCount,
          layers,
          storeys: manifest?.storeys ?? [],
        });
      },
      onSelection: (selection) => useUsdStore.getState().setSelection(selection),
      onError: (message) => useUsdStore.getState().setError(message),
    });

    // Exposed so the panel controls can drive visibility without prop-drilling.
    (window as unknown as { __usdEngine?: UsdEngine }).__usdEngine = engine;
    // The store too: the headless verification reads the live selection through
    // it rather than scraping the DOM, so the assertion exercises the same
    // state the panel renders from.
    (window as unknown as { __usdStore?: typeof useUsdStore }).__usdStore = useUsdStore;

    void fetch("/api/config")
      .then((res) => (res.ok ? res.json() : null))
      .then((cfg: { modelTitle?: string } | null) => {
        if (cfg?.modelTitle) useUsdStore.getState().setModelTitle(cfg.modelTitle);
      })
      .catch(() => {
        /* the header falls back to the default */
      });

    engine.load(container).then(async () => {
      // The tree is built from the prim paths recorded during load, so it is
      // free now and never needs rebuilding.
      try {
        useUsdStore.getState().setTree(engine.buildTree());
      } catch (err) {
        console.warn("[usd] tree build failed", err);
      }

      // Optional Gaussian-splat overlay, driven entirely by the URL so the
      // house itself stays untouched:
      //   ?splat=/splats/living.spz&sx=..&sy=..&sz=..&yaw=..&tx=..&ty=..&tz=..
      const params = new URLSearchParams(window.location.search);
      const splatUrl = params.get("splat");
      if (splatUrl) {
        try {
          const status = await engine.loadSplat(splatUrl, transformFromParams(params));
          console.info(
            `[splat] ${status.splatCount.toLocaleString()} splats from ${status.url}`,
            status.transform,
          );
        } catch (err) {
          // Never let an overlay take the house down: the scene is already up.
          console.warn("[splat] overlay failed to load", err);
        }
      }
    }).catch((err) => {
      store.setError(err instanceof Error ? err.message : String(err));
    });

    return () => {
      engine.dispose();
      delete (window as unknown as { __usdEngine?: UsdEngine }).__usdEngine;
    };
  }, []);

  return <div ref={containerRef} className="absolute inset-0" style={{ visibility: "hidden" }} />;
}
