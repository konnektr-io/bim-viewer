/**
 * Section controls: a movable cut plane with an above/below flip.
 *
 * Storey isolation cannot express "everything above the first floor" — it can
 * only show one whole storey. This is a real section: the plane sits at a height
 * you choose and keeps one side, so you can peel the house open storey by storey
 * and look down into it, or look up at it from underneath.
 *
 * SHARED BY BOTH TABS. The `format` prop picks the store to read and write and
 * the engine to call; everything else is identical. That works because
 * `SectionPlane` is format-agnostic by construction — it clips by assigning
 * `material.clippingPlanes`, which is all a stock-three.js scene (USD) needs,
 * and the IFC engine additionally hands the same plane to Fragments' renderer.
 *
 * `embedded` drops the Card and the title bar, because `App` wraps this in the
 * shared collapsible frame and owns the header. It also keeps `SectionToggle`
 * outside the collapsed body: whether the cut is live is the one thing about
 * this panel you need to know without opening it.
 */
import { useUsdStore } from "@/store/usdStore";
import { useViewerStore } from "@/store/viewerStore";
import type { ViewerEngine } from "@/viewer/engine";
import type { UsdEngine } from "@/viewer/usdEngine";
import type { SectionState } from "@/viewer/sectionPlane";
import type { Format } from "@/viewer/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

const AXES = [
  { value: "y", label: "Height" },
  { value: "x", label: "Width" },
  { value: "z", label: "Depth" },
] as const;

/** Read the section from whichever store this format owns. */
function useSection(format: Format): SectionState {
  const ifcSection = useViewerStore((s) => s.section);
  const usdSection = useUsdStore((s) => s.section);
  return format === "usd" ? usdSection : ifcSection;
}

/** Write a patch to the right store, then hand the MERGED state to the engine. */
function useApplySection(format: Format): (patch: Partial<SectionState>) => void {
  return (patch) => {
    const usd = format === "usd";
    if (usd) useUsdStore.getState().setSection(patch);
    else useViewerStore.getState().setSection(patch);

    // Read the MERGED state back: the engine wants the whole section, not only
    // the fields this click touched.
    const merged = usd ? useUsdStore.getState().section : useViewerStore.getState().section;
    const engine = (window as unknown as { __bimEngine?: ViewerEngine; __usdEngine?: UsdEngine });
    const target = usd ? engine.__usdEngine : engine.__bimEngine;
    target?.setSection(merged);
  };
}

export function SectionToggle({ format }: { format: Format }) {
  const section = useSection(format);
  const apply = useApplySection(format);

  return (
    <Button
      size="sm"
      variant={section.enabled ? "default" : "outline"}
      onClick={() => apply({ enabled: !section.enabled })}
      aria-pressed={section.enabled}
      aria-label={section.enabled ? "Turn the section off" : "Turn the section on"}
    >
      {section.enabled ? "On" : "Off"}
    </Button>
  );
}

export function SectionControls({
  format,
  embedded = false,
}: {
  format: Format;
  /** True when a parent already renders the card and the title bar. */
  embedded?: boolean;
}) {
  const section = useSection(format);
  const apply = useApplySection(format);

  const body = (
    <CardContent className="space-y-3">
      <div className="flex gap-1">
        {AXES.map((axis) => (
          <Button
            key={axis.value}
            size="sm"
            variant={section.axis === axis.value ? "secondary" : "ghost"}
            className="flex-1"
            onClick={() => apply({ axis: axis.value as SectionState["axis"], enabled: true })}
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
  );

  if (embedded) return <div className="pt-4">{body}</div>;

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-sm">Section</CardTitle>
          <SectionToggle format={format} />
        </div>
      </CardHeader>
      {body}
    </Card>
  );
}
