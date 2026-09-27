/**
 * Section controls: a movable cut plane with an above/below flip.
 *
 * Storey isolation cannot express "everything above the first floor" — it can
 * only show one whole storey. This is a real section: the plane sits at a height
 * you choose and keeps one side, so you can peel the house open storey by storey
 * and look down into it, or look up at it from underneath.
 */
import { useViewerStore } from "@/store/viewerStore";
import type { ViewerEngine } from "@/viewer/engine";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

const getEngine = (): ViewerEngine | undefined =>
  (window as unknown as { __bimEngine?: ViewerEngine }).__bimEngine;

const AXES = [
  { value: "y", label: "Height" },
  { value: "x", label: "Width" },
  { value: "z", label: "Depth" },
] as const;

export function SectionControls() {
  const section = useViewerStore((s) => s.section);
  const setSection = useViewerStore((s) => s.setSection);

  const apply = (patch: Parameters<typeof setSection>[0]) => {
    setSection(patch);
    getEngine()?.setSection(useViewerStore.getState().section);
  };

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-sm">Section</CardTitle>
          <Button
            size="sm"
            variant={section.enabled ? "default" : "outline"}
            onClick={() => apply({ enabled: !section.enabled })}
            aria-pressed={section.enabled}
          >
            {section.enabled ? "On" : "Off"}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex gap-1">
          {AXES.map((axis) => (
            <Button
              key={axis.value}
              size="sm"
              variant={section.axis === axis.value ? "secondary" : "ghost"}
              className="flex-1"
              onClick={() => apply({ axis: axis.value, enabled: true })}
            >
              {axis.label}
            </Button>
          ))}
        </div>

        <div className="space-y-1">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>Position</span>
            <span className="tabular-nums">{Math.round(section.offset * 100)}%</span>
          </div>
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={Math.round(section.offset * 100)}
            className="w-full accent-[var(--brand-teal)]"
            onChange={(event) => apply({ offset: Number(event.target.value) / 100, enabled: true })}
            aria-label="Section position"
          />
        </div>

        {/*
          Which half survives. The plane does not move — only its normal flips —
          so the same slider shows what is above the cut or what is below it.
        */}
        <div className="space-y-1">
          <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Show
          </div>
          <div className="flex gap-1">
            <Button
              size="sm"
              variant={section.side === "negative" ? "secondary" : "ghost"}
              className="flex-1"
              onClick={() => apply({ side: "negative", enabled: true })}
            >
              Below
            </Button>
            <Button
              size="sm"
              variant={section.side === "positive" ? "secondary" : "ghost"}
              className="flex-1"
              onClick={() => apply({ side: "positive", enabled: true })}
            >
              Above
            </Button>
          </div>
        </div>

        <p className="text-xs text-muted-foreground">
          {section.side === "negative"
            ? "Everything under the cut is kept."
            : "Everything over the cut is kept."}
        </p>
      </CardContent>
    </Card>
  );
}
