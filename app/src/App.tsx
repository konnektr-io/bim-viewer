import { SelectionDetail } from "@/components/SelectionDetail";
import { StoreyList } from "@/components/StoreyList";
import { FormatTabs } from "@/components/FormatTabs";
import { UsdPlaceholder } from "@/components/UsdPlaceholder";
import { ViewControls } from "@/components/ViewControls";
import { ViewerCanvas } from "@/components/ViewerCanvas";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useViewerStore } from "@/store/viewerStore";

function StatusLine() {
  const status = useViewerStore((s) => s.status);
  const visible = useViewerStore((s) => s.visibleCount);
  const total = useViewerStore((s) => s.totalCount);

  if (status.state === "error") {
    return <div className="text-sm text-destructive">{status.message}</div>;
  }
  if (status.state === "loading") {
    return <div className="text-sm text-muted-foreground">{status.detail}</div>;
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
  return <div className="text-sm text-muted-foreground">Loading…</div>;
}

export default function App() {
  const format = useViewerStore((s) => s.format);
  const isReady = useViewerStore((s) => s.status.state === "ready");

  return (
    <div className="h-dvh w-full overflow-hidden bg-background text-foreground">
      {format === "ifc" ? <ViewerCanvas /> : null}
      {format === "usd" ? <UsdPlaceholder /> : null}
      <FormatTabs />

      <aside className="absolute left-3 top-3 z-10 max-h-[calc(100dvh-1.5rem)] w-80 max-w-[calc(100vw-1.5rem)] overflow-y-auto">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Achterhekers 57</CardTitle>
          </CardHeader>
          <CardContent>
            <StatusLine />
            {format === "ifc" && isReady ? (
              <div className="mt-4 space-y-4">
                <ViewControls />
                <div>
                  <div className="mb-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    Storey
                  </div>
                  <StoreyList />
                </div>
                <SelectionDetail />
              </div>
            ) : null}
          </CardContent>
        </Card>
      </aside>
    </div>
  );
}
