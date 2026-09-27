import { Maximize } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useViewerStore } from "@/store/viewerStore";
import type { ViewerEngine } from "@/viewer/engine";

const getEngine = (): ViewerEngine | undefined =>
  (window as unknown as { __bimEngine?: ViewerEngine }).__bimEngine;

/**
 * Navigation: frame everything.
 *
 * "Frame all" exists because the initial camera can land somewhere the model
 * is not — a lost model should be one click to recover, never a reload.
 *
 * There are deliberately NO view buttons here: the view cube in the viewport's
 * corner does orientation, and a row of text presets to keep in sync with it
 * only added ways for the two to disagree.
 */
export function ViewControls() {
  const status = useViewerStore((s) => s.status);
  const setLoading = useViewerStore((s) => s.setLoading);
  const setError = useViewerStore((s) => s.setError);
  const setVisibility = useViewerStore((s) => s.setVisibility);

  if (status.state !== "ready") return null;

  const run = async (label: string, fn: () => Promise<unknown>) => {
    const engine = getEngine();
    if (!engine) return;
    setLoading(label);
    try {
      await fn();
      setVisibility(engine.visibleCount, engine.totalCount);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      // Must always return the status line to `ready`. Leaving it on
      // "loading" hides the storey list and every other control, because they
      // are gated on `status.state === "ready"`.
      useViewerStore.getState().setReady({
        elementCount: engine.totalCount,
        storeys: useViewerStore.getState().storeys,
        rooms: useViewerStore.getState().rooms,
      });
    }
  };

  return (
    <Button
      variant="secondary"
      size="sm"
      className="w-full justify-start"
      onClick={() =>
        void run("Framing…", async () => {
          const engine = getEngine();
          if (!engine) return;
          await engine.frameAll();
        })
      }
    >
      <Maximize className="size-4" />
      Frame all
    </Button>
  );
}
