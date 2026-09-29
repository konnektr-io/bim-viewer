import { Box } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useViewerStore } from "@/store/viewerStore";
import type { Format } from "@/viewer/types";

/** The single entry point for both model formats. */
export function FormatTabs() {
  const format = useViewerStore((s) => s.format);
  const setFormat = useViewerStore((s) => s.setFormat);

  const tab = (value: Format, label: string) => (
    <Button
      key={value}
      size="sm"
      variant={format === value ? "default" : "ghost"}
      onClick={() => setFormat(value)}
      className="gap-2"
    >
      <Box className="size-4" />
      {label}
    </Button>
  );

  return (
    <div
      role="tablist"
      className="absolute left-1/2 top-3 z-20 flex -translate-x-1/2 gap-1 rounded-lg border bg-card p-1"
    >
      {tab("ifc", "IFC")}
      {tab("usd", "USD")}
    </div>
  );
}
