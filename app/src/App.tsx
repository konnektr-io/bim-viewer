import { SelectionDetail } from "@/components/SelectionDetail";
import { StoreyList } from "@/components/StoreyList";
import { FormatTabs } from "@/components/FormatTabs";
import { UsdCanvas } from "@/components/UsdCanvas";
import { UsdLayerList, UsdStoreyList } from "@/components/UsdLayerList";
import { UsdSelectionDetail } from "@/components/UsdSelectionDetail";
import { ViewControls } from "@/components/ViewControls";
import { SectionControls } from "@/components/SectionControls";
import { ViewerCanvas } from "@/components/ViewerCanvas";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
      {format === "ifc" ? <ViewerCanvas /> : null}
      {format === "usd" ? <UsdCanvas /> : null}
      <FormatTabs />

      {/*
        LEFT: layers and views — what is shown, and how.
        The view cube lives in the viewport's top-right corner, so it does not
        need a row of text buttons here any more.
      */}
      <aside className="absolute left-3 top-3 z-10 max-h-[calc(100dvh-1.5rem)] w-72 max-w-[calc(100vw-1.5rem)] overflow-y-auto">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="truncate text-sm">{title}</CardTitle>
          </CardHeader>
          <CardContent>
            <StatusLine />
            {format === "ifc" && isReady ? (
              <div className="mt-4 space-y-4">
                <ViewControls format="ifc" />
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
                <UsdLayerList />
                <UsdStoreyList />
              </div>
            ) : null}
          </CardContent>
        </Card>
      </aside>

      {/* RIGHT: what you clicked, and the section cut. */}
      <aside className="absolute right-3 top-3 z-10 flex max-h-[calc(100dvh-1.5rem)] w-96 max-w-[calc(100vw-1.5rem)] flex-col gap-3 overflow-y-auto">
        {format === "ifc" && isReady ? (
          <>
            <SectionControls format="ifc" />
            <SelectionDetail />
          </>
        ) : null}
        {format === "usd" && usdReady ? (
          <>
            <SectionControls format="usd" />
            <UsdSelectionDetail />
          </>
        ) : null}
      </aside>
    </div>
  );
}
