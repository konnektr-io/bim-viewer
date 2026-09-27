import { Layers } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useViewerStore } from "@/store/viewerStore";
import type { ViewerEngine } from "@/viewer/engine";

/**
 * Storey switcher. "All" restores the full model; a storey shows only its own
 * elements. A storey with 0 elements is a real state (A_Kelder is empty in this
 * model) so it is shown, not hidden.
 */
export function StoreyList() {
  const storeys = useViewerStore((s) => s.storeys);
  const active = useViewerStore((s) => s.activeStorey);
  const setStorey = useViewerStore((s) => s.setStorey);
  const setVisibility = useViewerStore((s) => s.setVisibility);
  const status = useViewerStore((s) => s.status);

  if (status.state !== "ready" || storeys.length === 0) return null;

  const apply = async (localId: number | null) => {
    setStorey(localId);
    const engine = (window as unknown as { __bimEngine?: ViewerEngine }).__bimEngine;
    if (!engine) return;
    const { visible, total } = await engine.setStorey(localId);
    setVisibility(visible, total);
  };

  return (
    <div className="flex flex-col gap-1">
      <Button
        variant={active === null ? "default" : "secondary"}
        size="sm"
        className="justify-start"
        onClick={() => void apply(null)}
      >
        <Layers className="size-4" />
        All
      </Button>
      {storeys.map((storey) => (
        <Button
          key={storey.localId}
          variant={active === storey.localId ? "default" : "secondary"}
          size="sm"
          className="justify-between"
          title={`${storey.elementCount} elements`}
          onClick={() => void apply(storey.localId)}
        >
          <span className="truncate">{storey.name}</span>
          <span className="ml-2 shrink-0 text-xs opacity-70">{storey.elementCount}</span>
        </Button>
      ))}
    </div>
  );
}
