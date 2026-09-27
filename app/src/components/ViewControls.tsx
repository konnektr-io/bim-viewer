import { Box, Maximize } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useViewerStore } from "@/store/viewerStore";
import type { ViewerEngine } from "@/viewer/engine";
import { VIEW_PRESETS, VIEW_PRESET_ORDER, type ViewPreset } from "@/viewer/viewPresets";

const getEngine = (): ViewerEngine | undefined =>
  (window as unknown as { __bimEngine?: ViewerEngine }).__bimEngine;

/**
 * Navigation: frame everything, and snap to a standard view.
 *
 * "Frame all" exists because the initial camera can land somewhere the model
 * is not — a lost model should be one click to recover, never a reload.
 */
export function ViewControls() {
  const status = useViewerStore((s) => s.status);
  const setLoading = useViewerStore((s) => s.setLoading);
  const setError = useViewerStore((s) => s.setError);
  const setVisibility = useViewerStore((s) => s.setVisibility);
  const activeView = useViewerStore((s) => s.activeView);

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
    <div className="space-y-2">
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

      <div>
        <div className="mb-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
          View
        </div>
        {/* A 2x4 grid reads as a view cube flattened out: the four elevations
            plus top/bottom, with iso as the neutral default. */}
        <div className="grid grid-cols-4 gap-1">
          {VIEW_PRESET_ORDER.map((preset) => {
            const { label } = VIEW_PRESETS[preset];
            const isActive = activeView === preset;
            return (
              <Button
                key={preset}
                variant={isActive ? "default" : "secondary"}
                size="sm"
                className="h-8 px-1 text-[11px]"
                title={`${label} view`}
                onClick={() =>
                  void run(`Switching to ${label.toLowerCase()} view…`, async () => {
                    const engine = getEngine();
                    if (!engine) return;
                    await engine.setView(preset as ViewPreset);
                    useViewerStore.getState().setActiveView(preset);
                  })
                }
              >
                <Box className="size-3" />
                {label}
              </Button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
