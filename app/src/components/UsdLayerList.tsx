import { Layers } from "lucide-react";

import { useUsdStore } from "@/store/usdStore";
import type { UsdEngine } from "@/viewer/usdEngine";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

const getEngine = (): UsdEngine | undefined =>
  (window as unknown as { __usdEngine?: UsdEngine }).__usdEngine;

/**
 * The layer toggles.
 *
 * A "layer" here is a USD **root prim** plus the sublayer that contributed it.
 * That is an honest mapping for this model because the build step verifies it:
 * every root prim is fed by exactly one layer, so hiding the root prim really is
 * hiding the layer. If a future export mixes two layers into one root prim, the
 * build fails rather than shipping a toggle that lies — after flattening, the
 * sublayer structure no longer exists in the file the browser downloads, so
 * nothing could separate them at runtime.
 *
 * The visible state lives in the store, and every toggle pushes it into the
 * engine and reads the resulting counts back, so the status line cannot drift
 * from what is actually drawn.
 */
export function UsdLayerList() {
  const layers = useUsdStore((s) => s.layers);
  const visible = useUsdStore((s) => s.visibleLayers);
  const setLayerVisible = useUsdStore((s) => s.setLayerVisible);
  const showAllLayers = useUsdStore((s) => s.showAllLayers);

  if (!layers.length) return null;

  const apply = (fn: () => { visible: number; total: number }): void => {
    const engine = getEngine();
    if (!engine) return;
    const counts = fn();
    useUsdStore.getState().setVisibility(counts.visible, counts.total);
  };

  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
          <Layers className="size-3" />
          Layers
        </div>
        <Button
          size="sm"
          variant="ghost"
          className="h-6 px-2 text-[11px]"
          onClick={() => {
            showAllLayers();
            apply(() => {
              const engine = getEngine();
              for (const layer of layers) engine?.setLayerVisible(layer.id, true);
              return {
                visible: engine?.visibleCount ?? 0,
                total: engine?.totalCount ?? 0,
              };
            });
          }}
        >
          All
        </Button>
      </div>
      <div className="space-y-1">
        {layers.map((layer) => {
          const on = visible.has(layer.id);
          return (
            <label
              key={layer.id}
              className="flex min-w-0 cursor-pointer items-center gap-2 text-sm"
              title={layer.sublayer ? `from ${layer.sublayer}` : layer.label}
            >
              <input
                type="checkbox"
                checked={on}
                onChange={(event) => {
                  const next = event.target.checked;
                  setLayerVisible(layer.id, next);
                  apply(() => getEngine()?.setLayerVisible(layer.id, next) ?? { visible: 0, total: 0 });
                }}
                className="size-3.5 shrink-0 accent-primary"
                data-testid={`usd-layer-${layer.id}`}
              />
              <span className="min-w-0 flex-1 truncate">{layer.label}</span>
              <Badge variant="secondary" className="shrink-0 tabular-nums">
                {layer.meshCount.toLocaleString("en-US")}
              </Badge>
            </label>
          );
        })}
      </div>
    </div>
  );
}

/** The storey list, from the IFC path segments the build step found. */
export function UsdStoreyList() {
  const storeys = useUsdStore((s) => s.storeys);
  const activeStorey = useUsdStore((s) => s.activeStorey);
  const setStorey = useUsdStore((s) => s.setStorey);

  // A group that is not the house is not a storey (the bathroom layer is not).
  const real = storeys.filter((group) => !group.id.startsWith("("));
  if (!real.length) return null;

  const choose = (storeyId: string | null): void => {
    setStorey(storeyId);
    const engine = getEngine();
    if (!engine) return;
    const counts = engine.setStorey(storeyId);
    useUsdStore.getState().setVisibility(counts.visible, counts.total);
  };

  return (
    <div>
      <div className="mb-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
        Storey
      </div>
      <div className="space-y-1">
        <Button
          size="sm"
          variant={activeStorey === null ? "default" : "ghost"}
          className="h-7 w-full justify-start px-2 text-xs"
          onClick={() => choose(null)}
        >
          Whole model
        </Button>
        {real.map((storey) => (
          <Button
            key={storey.id}
            size="sm"
            variant={activeStorey === storey.id ? "default" : "ghost"}
            className="h-7 w-full min-w-0 justify-start gap-2 px-2 text-xs"
            onClick={() => choose(activeStorey === storey.id ? null : storey.id)}
            title={storey.id}
          >
            <span className="min-w-0 flex-1 truncate text-left">{storey.label}</span>
            <Badge variant="secondary" className="shrink-0 tabular-nums">
              {storey.meshCount.toLocaleString("en-US")}
            </Badge>
          </Button>
        ))}
      </div>
    </div>
  );
}
