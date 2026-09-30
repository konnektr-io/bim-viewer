import { useMemo, useState } from "react";
import { Copy } from "lucide-react";

import { useUsdStore } from "@/store/usdStore";
import { Button } from "@/components/ui/button";
import { CollapsiblePanel } from "@/components/CollapsiblePanel";
import { Separator } from "@/components/ui/separator";

/**
 * Inspector for the picked USD prim.
 *
 * Shaped like the IFC attribute inspector on purpose — same collapsible rows,
 * same copyable identifiers — so the two tabs feel like one tool. What differs is
 * what there IS to show: the USD carries no property sets and no GlobalId, so
 * this shows the prim path (the identity) and the geometry facts, and states
 * plainly that semantics live in the IFC tab.
 */
export function UsdSelectionDetail() {
  const selection = useUsdStore((s) => s.selection);
  const [filter, setFilter] = useState("");

  const copyAllText = useMemo(() => {
    if (!selection) return "";
    const lines = [`USD prim ${selection.path}`];
    if (selection.ifc.storey) lines.push(`  Storey   = ${selection.ifc.storey}`);
    if (selection.ifc.category) lines.push(`  Category = ${selection.ifc.category}`);
    for (const [key, value] of Object.entries(selection.attributes).sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      lines.push(`  ${key} = ${value}`);
    }
    return lines.join("\n");
  }, [selection]);

  if (!selection) return null;

  const query = filter.trim().toLowerCase();
  const rows = Object.entries(selection.attributes)
    .sort(([a], [b]) => a.localeCompare(b))
    .filter(([k, v]) => !query || k.toLowerCase().includes(query) || v.toLowerCase().includes(query));

  return (
    <CollapsiblePanel
      id="selection-usd"
      title="Prim"
      className="min-w-0"
      testId="usd-selection-panel"
      actions={
        <>
          <CopyButton text={selection.path} label="copy path" />
          <CopyButton text={copyAllText} label="copy all" />
        </>
      }
    >
      <div className="min-w-0 space-y-1 text-sm">
        <Row label="Path" value={selection.path} mono testId="usd-prim-path" />
        <Row label="Layer" value={selection.rootPrim} />
        {selection.ifc.storey ? <Row label="Storey" value={selection.ifc.storey} /> : null}
        {selection.ifc.category ? <Row label="Category" value={selection.ifc.category} /> : null}
        {selection.ifc.element ? <Row label="Element" value={selection.ifc.element} /> : null}

        <div className="pt-2">
          <input
            type="search"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Filter attributes…"
            aria-label="Filter attributes"
            className="h-7 w-full min-w-0 rounded-md border border-input bg-background px-2 text-xs outline-none placeholder:text-muted-foreground focus-visible:border-ring"
          />
        </div>

        {rows.length > 0 ? (
          <>
            <Separator className="my-3" />
            <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Attributes
            </div>
            {rows.map(([key, value]) => (
              <Row key={key} label={key} value={value} />
            ))}
          </>
        ) : null}

        <p className="pt-3 text-xs text-muted-foreground">
          The USD carries geometry, not semantics. Property sets, room names and the
          GlobalId live in the <strong className="text-foreground">IFC</strong> view.
        </p>
      </div>
    </CollapsiblePanel>
  );
}

function Row({
  label,
  value,
  mono,
  testId,
}: {
  label: string;
  value: string;
  mono?: boolean;
  testId?: string;
}) {
  return (
    <div
      className="grid min-w-0 grid-cols-[6.5rem_minmax(0,1fr)] gap-2"
      {...(testId ? { "data-testid": testId, "data-value": value } : {})}
    >
      <dt className="truncate text-muted-foreground" title={label}>
        {label}
      </dt>
      <dd
        className={
          mono
            ? "min-w-0 break-all font-mono text-xs"
            : "min-w-0 break-words [overflow-wrap:anywhere]"
        }
      >
        {value}
      </dd>
    </div>
  );
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      size="sm"
      variant="ghost"
      className="h-6 px-2 text-[11px]"
      title={label}
      aria-label={label}
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1200);
        });
      }}
    >
      {copied ? "Copied" : <Copy className="size-3" />}
    </Button>
  );
}
