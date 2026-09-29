/**
 * Mounts the ThatOpen engine into a plain div and keeps React out of its way.
 *
 * The engine owns a render loop; React only receives status callbacks. The
 * component unmounts the engine with the div, and never re-creates it for a
 * state change.
 */
import { useEffect, useRef } from "react";

import { useViewerStore } from "@/store/viewerStore";
import { ViewerEngine } from "@/viewer/engine";

export function ViewerCanvas() {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const store = useViewerStore.getState();
    const engine = new ViewerEngine({
      onProgress: (detail) => useViewerStore.getState().setLoading(detail),
      onReady: (info) => useViewerStore.getState().setReady(info),
      onSelection: (selection) => useViewerStore.getState().setSelection(selection),
      onError: (message) => useViewerStore.getState().setError(message),
    });

    // The title comes from the backend config, not from a constant here.
    void fetch("/api/config")
      .then((res) => (res.ok ? res.json() : null))
      .then((cfg: { modelTitle?: string } | null) => {
        if (cfg?.modelTitle) useViewerStore.getState().setModelTitle(cfg.modelTitle);
        document.title = cfg?.modelTitle
          ? `${cfg.modelTitle} — BIM viewer`
          : "BIM viewer";
      })
      .catch(() => {
        /* the header falls back to the default; not worth surfacing */
      });

    // Exposed so the storey buttons can drive visibility without prop-drilling
    // the engine through the tree.
    (window as unknown as { __bimEngine?: ViewerEngine }).__bimEngine = engine;

    engine.load(container).then(() => {
      // Built from `getItemsOfCategories`, which is the only spatial query that
      // works on this model (see ViewerEngine.buildTree).
      void engine
        .buildTree()
        .then((tree) => useViewerStore.getState().setTree(tree))
        .catch((err) => console.warn("[ifc] tree build failed", err));
    }).catch((err) => {
      store.setError(err instanceof Error ? err.message : String(err));
    });

    return () => {
      engine.dispose();
      delete (window as unknown as { __bimEngine?: ViewerEngine }).__bimEngine;
    };
  }, []);

  return <div ref={containerRef} className="absolute inset-0" style={{ visibility: "hidden" }} />;
}
