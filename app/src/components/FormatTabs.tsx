import { Box } from "lucide-react";

import { useViewerStore } from "@/store/viewerStore";
import { pathForFormat } from "@/lib/formatRoute";
import { cn } from "@/lib/utils";
import type { Format } from "@/viewer/types";

/**
 * The single entry point for both model formats.
 *
 * Each tab is a real `<a href="/ifc">` / `<a href="/usd">`, which is what makes
 * those URLs shareable: right-click → copy link address, middle-click, and
 * "open in new tab" all work without any extra code. The click is intercepted to
 * avoid a full reload — the engines are big and reloading to switch a view is
 * the thing the format URL exists to prevent.
 *
 * `role="button"` is set explicitly and deliberately. An anchor without it is a
 * LINK, and every headless check in `work/ifc/` selects these tabs with
 * `get_by_role("button", name="USD")`. Overriding the role keeps them links to
 * the browser while staying the same accessible control to the tests — the one
 * reason to deviate from the plain `<a>` default here.
 */
export function FormatTabs() {
  const format = useViewerStore((s) => s.format);
  const setFormat = useViewerStore((s) => s.setFormat);

  const tab = (value: Format, label: string) => {
    const active = format === value;
    return (
      <a
        key={value}
        role="button"
        href={pathForFormat(value)}
        onClick={(event) => {
          // Plain left click: switch in place. Modified clicks (ctrl/cmd/shift,
          // middle) fall through to the browser, which is the point of a link.
          if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
          event.preventDefault();
          setFormat(value);
        }}
        className={cn(
          "inline-flex h-8 shrink-0 items-center justify-center gap-2 rounded-md px-2.5 text-sm font-medium transition-all",
          active
            ? "bg-primary text-primary-foreground"
            : "hover:bg-accent hover:text-accent-foreground",
        )}
      >
        <Box className="size-4" />
        {label}
      </a>
    );
  };

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
