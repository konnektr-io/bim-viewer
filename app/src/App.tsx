import { SelectionDetail } from "@/components/SelectionDetail";
import { StoreyList } from "@/components/StoreyList";
import { FormatTabs } from "@/components/FormatTabs";
import { UsdCanvas } from "@/components/UsdCanvas";
import { UsdLayerList, UsdStoreyList } from "@/components/UsdLayerList";
import { UsdSelectionDetail } from "@/components/UsdSelectionDetail";
import { ViewControls } from "@/components/ViewControls";
import { SectionControls, SectionToggle } from "@/components/SectionControls";
import { ModelTree } from "@/components/ModelTree";
import { ViewerCanvas } from "@/components/ViewerCanvas";
import { CollapsiblePanel } from "@/components/CollapsiblePanel";
import { useUsdStore } from "@/store/usdStore";
import { useViewerStore } from "@/store/viewerStore";

function StatusLine() {
  const status = useViewerStore((s) => s.status);
  const usdStatus = useUsdStore((s) => s.status);
  const visible = useViewerStore((s) => s.visibleCount);
  const total = useViewerStore((s) => s.totalCount);
  const usdVisible = useUsdStore((s) => s.visibleCount);
  const usdTotal = useUsdStore((s) => s.totalCount);

  if (status.state === "error") {
    return <div className="text-sm text-destructive">{status.message}</div>;
  }
  if (usdStatus.state === "error") {
    return <div className="text-sm text-destructive">{usdStatus.message}</div>;
  }
  if (status.state === "loading") {
    return <div className="text-sm text-muted-foreground">{status.detail}</div>;
  }
  if (usdStatus.state === "loading") {
    return <div className="text-sm text-muted-foreground">{usdStatus.detail}</div>;
  }
  if (status.state === "ready") {
    return (
      <div className="text-sm text-muted-foreground">
        {status.elementCount.toLocaleString("en-US")} elements · {status.spaceCount} rooms ·{" "}
        {status.storeyCount} storeys
        {visible !== null && total !== null && visible !== total
          ? ` — ${visible.toLocaleString("en-US")} of ${total.toLocaleString("en-US")} visible`
          : ""}
      </div>
    );
  }
  if (usdStatus.state === "ready") {
    return (
      <div className="text-sm text-muted-foreground">
        {usdStatus.meshCount.toLocaleString("en-US")} meshes · {usdStatus.layerCount} layers
        {usdVisible !== null && usdTotal !== null && usdVisible !== usdTotal
          ? ` — ${usdVisible.toLocaleString("en-US")} of ${usdTotal.toLocaleString("en-US")} visible`
          : ""}
      </div>
    );
  }
  return <div className="text-sm text-muted-foreground">Loading…</div>;
}

export default function App() {
  const format = useViewerStore((s) => s.format);
  const modelTitle = useViewerStore((s) => s.modelTitle);
  const usdTitle = useUsdStore((s) => s.modelTitle);
  const isReady = useViewerStore((s) => s.status.state === "ready");
  const usdReady = useUsdStore((s) => s.status.state === "ready");
  const title = format === "usd" && usdTitle ? usdTitle : modelTitle;

  return (
    <div className="h-dvh w-full overflow-hidden bg-background text-foreground">
      {/*
        ONE canvas per view, mounted only for the active format.

        This is what makes a cold load of /usd instant: the IFC engine is never
        constructed, so the 17.7 MB conversion never starts and cannot fail in
        the background. It is also why the URL is the right way to choose the
        view — the alternative (mounting both, hiding one) is exactly the
        half-loaded engine that produces the "fragments not loaded" errors.
      */}
      {format === "ifc" ? <ViewerCanvas /> : null}
      {format === "usd" ? <UsdCanvas /> : null}
      <FormatTabs />

      {/*
        LEFT: layers and views — what is shown, and how.
        The view cube lives in the viewport's top-right corner, so it does not
        need a row of text buttons here any more.

        Every panel here collapses, because the reason to collapse one is always
        the same: to see the model, not the controls. Which is why the frame
        (not the status line) is what collapses — a folded panel still shows
        the model name, so you never lose track of what you are looking at.
      */}
      <aside className="absolute left-3 top-3 z-10 max-h-[calc(100dvh-1.5rem)] w-80 max-w-[calc(100vw-1.5rem)] overflow-y-auto">
        <CollapsiblePanel
          id="model"
          title={title}
          titleClassName="truncate text-sm normal-case tracking-normal"
          testId="panel-model"
        >
          <StatusLine />
          {format === "ifc" && isReady ? (
            <div className="mt-4 space-y-4">
              <ViewControls format="ifc" />
              <ModelTree format="ifc" />
              <div>
                <div className="mb-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  Storey
                </div>
                <StoreyList />
              </div>
            </div>
          ) : null}
          {format === "usd" && usdReady ? (
            <div className="mt-4 space-y-4">
              <ViewControls format="usd" />
              <ModelTree format="usd" />
              <UsdLayerList />
              <UsdStoreyList />
            </div>
          ) : null}
        </CollapsiblePanel>
      </aside>

      {/*
        RIGHT: what you clicked, and the section cut. Both are collapsible, and
        both default to OPEN: unlike the left frame, they are only on screen
        once there is something to act on, so folding them away by default
        would hide the answer to the click that just happened.
      */}
      <aside className="absolute right-3 top-3 z-10 flex max-h-[calc(100dvh-1.5rem)] w-96 max-w-[calc(100vw-1.5rem)] flex-col gap-3 overflow-y-auto">
        {format === "ifc" && isReady ? (
          <>
            <SectionPanel format="ifc" />
            <SelectionDetail />
          </>
        ) : null}
        {format === "usd" && usdReady ? (
          <>
            <SectionPanel format="usd" />
            <UsdSelectionDetail />
          </>
        ) : null}
      </aside>
    </div>
  );
}

/**
 * The section card, wrapped in the shared collapsible frame.
 *
 * Split out only so the two `format` branches above stay one line each; the
 * panel itself is the same one `SectionControls` has always rendered, and it
 * keeps its own On/Off control in the header — the section's state is the one
 * thing that must stay readable when the body is folded.
 */
function SectionPanel({ format }: { format: "ifc" | "usd" }) {
  return (
    <CollapsiblePanel
      id={`section-${format}`}
      title="Section"
      testId="panel-section"
      // The On/Off toggle lives here rather than inside the body, so a folded
      // section is still a control and not just a label.
      actions={<SectionToggle format={format} />}
    >
      <SectionControls format={format} embedded />
    </CollapsiblePanel>
  );
}
