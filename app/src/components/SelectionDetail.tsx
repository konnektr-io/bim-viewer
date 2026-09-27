import { useState } from "react";
import { ChevronDown, Copy } from "lucide-react";

import { useViewerStore } from "@/store/viewerStore";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { CIRCUIT_LABELS } from "@/viewer/labels";

/**
 * Detail panel for the current pick: what it is, which room, which circuit, and
 * every attribute the model carries for it.
 *
 * Collapsible because the attribute list can be long, and the ids are the point:
 * quoting the exact `localId` / `GlobalId` back is what makes an edit request
 * actionable ("move #12345") instead of a description.
 */
export function SelectionDetail() {
  const selection = useViewerStore((s) => s.selection);
  const [open, setOpen] = useState(true);
  const [showAll, setShowAll] = useState(false);

  if (!selection) return null;

  // Keep only the properties that are actually present on this element.
  const circuitRows: Array<{ key: string; label: string; value: string }> = [];
  for (const [key, label] of CIRCUIT_LABELS) {
    const value = selection.circuit?.[key];
    if (value !== undefined) circuitRows.push({ key, label, value });
  }

  const attributeRows = Object.entries(selection.attributes).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  const shown = showAll ? attributeRows : attributeRows.slice(0, 8);

  return (
    <Card className="min-w-0">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-xs uppercase tracking-wider text-muted-foreground">
            Selection
          </CardTitle>
          <div className="flex items-center gap-1">
            <CopyIdButton id={String(selection.localId)} label="localId" />
            <Button
              size="icon"
              variant="ghost"
              className="size-6"
              aria-label={open ? "Collapse selection" : "Expand selection"}
              aria-expanded={open}
              onClick={() => setOpen((value) => !value)}
            >
              <ChevronDown className={open ? "size-4 rotate-180 transition-transform" : "size-4 transition-transform"} />
            </Button>
          </div>
        </div>
      </CardHeader>

      {open ? (
        <CardContent className="min-w-0 space-y-1 text-sm">
          <Row label="Category" value={selection.category} />
          {selection.name ? <Row label="Name" value={selection.name} /> : null}
          <Row label="Room" value={selection.room ?? "—"} />
          <Row label="localId" value={String(selection.localId)} mono />
          {selection.guid ? <Row label="GlobalId" value={selection.guid} mono /> : null}

          {circuitRows.length > 0 ? (
            <>
              <Separator className="my-3" />
              <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Pset_ElectricalCircuit
              </div>
              {circuitRows.map(({ key, label, value }) => (
                <Row key={key} label={label} value={value} />
              ))}
            </>
          ) : null}

          {attributeRows.length > 0 ? (
            <>
              <Separator className="my-3" />
              <div className="flex items-center justify-between">
                <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  Attributes
                </div>
                {attributeRows.length > 8 ? (
                  <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px]" onClick={() => setShowAll((v) => !v)}>
                    {showAll ? "Fewer" : `All ${attributeRows.length}`}
                  </Button>
                ) : null}
              </div>
              {shown.map(([key, value]) => (
                <Row key={key} label={key} value={value} />
              ))}
            </>
          ) : null}
        </CardContent>
      ) : null}
    </Card>
  );
}

/**
 * A long id in a narrow column is the thing that made this panel scroll
 * sideways, so it breaks anywhere rather than only at word boundaries.
 */
function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="grid min-w-0 grid-cols-[6.5rem_minmax(0,1fr)] gap-2">
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

/** Copy an id to the clipboard, so it can be pasted straight into a request. */
function CopyIdButton({ id, label }: { id: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      size="sm"
      variant="ghost"
      className="h-6 px-2 text-[11px]"
      title={`Copy ${label}`}
      onClick={() => {
        void navigator.clipboard?.writeText(id).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1200);
        });
      }}
    >
      {copied ? "Copied" : <Copy className="size-3" />}
    </Button>
  );
}
