/**
 * Navigation: frame everything.
 *
 * "Frame all" exists because the initial camera can land somewhere the model
 * is not — a lost model should be one click to recover, never a reload.
 *
 * There are deliberately NO view buttons here: the view cube in the viewport's
 * corner does orientation, and a row of text presets to keep in sync with it
 * only added ways for the two to disagree.
 *
 * SHARED BY BOTH TABS: the `format` prop picks the store and the engine, and
 * both engines expose the same `frameAll() / visibleCount / totalCount`.
 */
import { Maximize } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useUsdStore } from "@/store/usdStore";
import { useViewerStore } from "@/store/viewerStore";
import type { ViewerEngine } from "@/viewer/engine";
import type { UsdEngine } from "@/viewer/usdEngine";
import type { Format } from "@/viewer/types";

export function ViewControls({ format }: { format: Format }) {
  const ifcStatus = useViewerStore((s) => s.status);
  const usdStatus = useUsdStore((s) => s.status);
  const status = format === "usd" ? usdStatus : ifcStatus;

  if (status.state !== "ready") return null;

  const run = async (): Promise<void> => {
    const usd = format === "usd";
    const engine = usd
      ? (window as unknown as { __usdEngine?: UsdEngine }).__usdEngine
      : (window as unknown as { __bimEngine?: ViewerEngine }).__bimEngine;
    if (!engine) return;

    if (usd) useUsdStore.getState().setLoading("Framing…");
    else useViewerStore.getState().setLoading("Framing…");

    try {
      await engine.frameAll();
      if (usd) {
        useUsdStore.getState().setVisibility(engine.visibleCount, engine.totalCount);
      } else {
        useViewerStore.getState().setVisibility(engine.visibleCount, engine.totalCount);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (usd) useUsdStore.getState().setError(message);
      else useViewerStore.getState().setError(message);
    } finally {
      // Always return the status line to `ready`: every other control is gated
      // on it, so leaving it on "loading" would hide the whole panel.
      if (usd) {
        const state = useUsdStore.getState();
        useUsdStore.getState().setReady({
          meshCount: engine.totalCount,
          layers: state.layers,
          storeys: state.storeys,
        });
      } else {
        const state = useViewerStore.getState();
        useViewerStore.getState().setReady({
          elementCount: engine.totalCount,
          storeys: state.storeys,
          rooms: state.rooms,
        });
      }
    }
  };

  return (
    <Button
      variant="secondary"
      size="sm"
      className="w-full justify-start"
      onClick={() => void run()}
    >
      <Maximize className="size-4" />
      Frame all
    </Button>
  );
}
