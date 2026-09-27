import { SelectionDetail } from "@/components/SelectionDetail";
import { StoreyList } from "@/components/StoreyList";
import { FormatTabs } from "@/components/FormatTabs";
import { UsdPlaceholder } from "@/components/UsdPlaceholder";
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
        {status.elementCount.toLocaleString("nl-BE")} elementen ·{" "}
        {status.spaceCount} ruimtes · {status.storeyCount} verdiepingen
        {visible !== null && total !== null && visible !== total
          ? ` — ${visible.toLocaleString("nl-BE")} van ${total.toLocaleString("nl-BE")} zichtbaar`
          : ""}
      </div>
    );
  }
  return <div className="text-sm text-muted-foreground">Laden…</div>;
}

export default function App() {
  const format = useViewerStore((s) => s.format);
  const showStoreys = useViewerStore((s) => s.status.state === "ready");

  return (
    <div className="h-dvh w-full overflow-hidden bg-background text-foreground">
      {format === "ifc" ? <ViewerCanvas /> : null}
      {format === "usd" ? <UsdPlaceholder /> : null}
      <FormatTabs />

      <aside className="absolute left-3 top-3 z-10 w-80 max-w-[calc(100vw-1.5rem)]">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Achterhekers 57</CardTitle>
          </CardHeader>
          <CardContent>
            <StatusLine />
            {format === "ifc" && showStoreys ? (
              <div className="mt-4 space-y-3">
                <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  Verdieping
                </div>
                <StoreyList />
                <SelectionDetail />
              </div>
            ) : null}
          </CardContent>
        </Card>
      </aside>
    </div>
  );
}
