import { useMemo, useState } from "react";
import { ChevronDown, Copy } from "lucide-react";

import { useViewerStore } from "@/store/viewerStore";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { CIRCUIT_LABELS } from "@/viewer/labels";
import type { PropertySet } from "@/viewer/types";

/**
 * Full attribute inspector for the current pick: identity first, then one
 * collapsible group per property set / quantity set, then materials, then the
 * element's own top-level attributes.
 *
 * Collapsible because a full property dump for a curtain wall is long, and
 * the ids are the point: quoting the exact `localId` / `GlobalId` back is
 * what makes an edit request actionable ("move #12345") instead of a
 * description.
 */
export function SelectionDetail() {
  const selection = useViewerStore((s) => s.selection);
  const [open, setOpen] = useState(true);
  const [showAll, setShowAll] = useState(false);
  const [filter, setFilter] = useState("");

  const query = filter.trim().toLowerCase();

  const matches = (name: string, value: string): boolean => {
    if (!query) return true;
    return (
      name.toLowerCase().includes(query) || value.toLowerCase().includes(query)
    );
  };

  const copyAllText = useMemo(() => {
    if (!selection) return "";
    const lines: string[] = [];
    lines.push(
      `${selection.category} #${selection.localId}${selection.guid ? `  ${selection.guid}` : ""}`,
    );
    if (selection.name) lines.push(`  Name = ${selection.name}`);
    if (selection.room) lines.push(`  Room = ${selection.room}`);
    if (selection.typeName) lines.push(`  Type = ${selection.typeName}`);
    for (const [key, value] of Object.entries(selection.attributes).sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      if (key === "Name") continue;
      lines.push(`  ${key} = ${value}`);
    }
    for (const set of selection.propertySets) {
      for (const [key, value] of Object.entries(set.properties)) {
        lines.push(`  ${set.name}.${key} = ${value}`);
      }
    }
    for (const layer of selection.materialLayers) {
      lines.push(
        `  Material = ${layer.name}${layer.thickness ? ` (${layer.thickness})` : ""}`,
      );
    }
    return lines.join("\n");
  }, [selection]);

  if (!selection) return null;

  // Keep only the properties that are actually present on this element.
  const circuitRows: Array<{ key: string; label: string; value: string }> = [];
  for (const [key, label] of CIRCUIT_LABELS) {
    const value = selection.circuit?.[key];
    if (value !== undefined) circuitRows.push({ key, label, value });
  }

  // The circuit set also lives in propertySets; don't render it twice.
  const otherSets: PropertySet[] = (selection.propertySets ?? []).filter(
    (set) => set.name !== "Pset_ElectricalCircuit" || set.kind === "type",
  );

  const filterSet = (set: PropertySet): Array<[string, string]> =>
    Object.entries(set.properties).filter(([k, v]) => matches(k, v));

  const visibleSets = query
    ? otherSets
        .map((set) => ({
          set,
          rows: filterSet(set),
          nameHit: set.name.toLowerCase().includes(query),
        }))
        .filter((entry) => entry.rows.length > 0 || entry.nameHit)
        .map((entry) => ({
          set: entry.set,
          rows: entry.nameHit && entry.rows.length === 0
            ? Object.entries(entry.set.properties)
            : entry.rows,
        }))
    : otherSets.map((set) => ({ set, rows: Object.entries(set.properties) }));

  const attributeRows = Object.entries(selection.attributes)
    .sort(([a], [b]) => a.localeCompare(b))
    .filter(([k, v]) => matches(k, v));
  const shown = showAll || query ? attributeRows : attributeRows.slice(0, 8);

  const materialRows = (selection.materialLayers ?? []).filter((layer) =>
    matches("Material", `${layer.name} ${layer.thickness ?? ""}`),
  );

  const circuitVisible = circuitRows.filter(({ label, value }) =>
    matches(label, value),
  );

  return (
    <Card className="min-w-0" data-testid="selection-panel">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-xs uppercase tracking-wider text-muted-foreground">
            Selection
          </CardTitle>
          <div className="flex items-center gap-1">
            <CopyIdButton id={String(selection.localId)} label="localId" />
            <CopyTextButton text={copyAllText} label="copy all" title="Copy all identifiers and properties" />
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
          {selection.typeName ? <Row label="Type" value={selection.typeName} /> : null}
          <RowWithCopy
            label="localId"
            value={String(selection.localId)}
            mono
            testId="selection-localId"
          />
          {selection.guid ? (
            <RowWithCopy
              label="GlobalId"
              value={selection.guid}
              mono
              testId="selection-guid"
            />
          ) : null}

          <div className="pt-2">
            <input
              type="search"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder="Filter properties…"
              aria-label="Filter properties"
              className="h-7 w-full min-w-0 rounded-md border border-input bg-background px-2 text-xs outline-none placeholder:text-muted-foreground focus-visible:border-ring"
            />
          </div>

          {circuitVisible.length > 0 ? (
            <>
              <Separator className="my-3" />
              <PsetGroup
                name="Pset_ElectricalCircuit"
                defaultOpen
                testId="pset-group-Pset_ElectricalCircuit"
              >
                {circuitVisible.map(({ key, label, value }) => (
                  <Row key={key} label={label} value={value} />
                ))}
              </PsetGroup>
            </>
          ) : null}

          {visibleSets.map(({ set, rows }) => (
            <div key={`${set.kind}#${set.name}`}>
              <Separator className="my-3" />
              <PsetGroup
                name={set.kind === "type" ? `${set.name} (type)` : set.name}
                badge={set.kind === "qto" ? "Qto" : set.kind === "type" ? "type" : undefined}
                testId={`pset-group-${set.name}`}
              >
                {rows.map(([key, value]) => (
                  <Row key={key} label={key} value={value} />
                ))}
              </PsetGroup>
            </div>
          ))}

          {materialRows.length > 0 ? (
            <>
              <Separator className="my-3" />
              <PsetGroup name="Materials" testId="pset-group-Materials">
                {materialRows.map((layer, index) => (
                  <Row
                    key={`${layer.name}-${index}`}
                    label={layer.thickness ?? "Material"}
                    value={layer.thickness ? `${layer.name} — ${layer.thickness}` : layer.name}
                  />
                ))}
              </PsetGroup>
            </>
          ) : null}

          {attributeRows.length > 0 ? (
            <>
              <Separator className="my-3" />
              <div className="flex items-center justify-between">
                <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  Attributes
                </div>
                {attributeRows.length > 8 && !query ? (
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

function PsetGroup({
  name,
  badge,
  defaultOpen = false,
  testId,
  children,
}: {
  name: string;
  badge?: string;
  defaultOpen?: boolean;
  testId?: string;
  children: React.ReactNode;
}) {
  const [groupOpen, setGroupOpen] = useState(defaultOpen);
  return (
    <div data-testid={testId}>
      <button
        type="button"
        aria-expanded={groupOpen}
        aria-label={`${groupOpen ? "Collapse" : "Expand"} ${name}`}
        onClick={() => setGroupOpen((value) => !value)}
        className="flex w-full min-w-0 items-center justify-between gap-2 py-1 text-left"
      >
        <span className="flex min-w-0 items-center gap-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
          <ChevronDown
            className={
              groupOpen
                ? "size-3 shrink-0 rotate-180 transition-transform"
                : "size-3 shrink-0 transition-transform"
            }
          />
          <span className="truncate" title={name}>
            {name}
          </span>
          {badge ? (
            <span className="shrink-0 rounded border px-1 text-[10px] normal-case tracking-normal">
              {badge}
            </span>
          ) : null}
        </span>
      </button>
      {groupOpen ? <div className="min-w-0 space-y-1">{children}</div> : null}
    </div>
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

function RowWithCopy({
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
    <div className="grid min-w-0 grid-cols-[6.5rem_minmax(0,1fr)_auto] items-start gap-2" data-testid={testId} data-value={value}>
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
      <dd>
        <CopyIdButton id={value} label={label} />
      </dd>
    </div>
  );
}

/** Copy an id to the clipboard, so it can be pasted straight into a request. */
function CopyIdButton({ id, label }: { id: string; label: string }) {
  return <CopyTextButton text={id} label={label} title={`Copy ${label}`} iconOnly />;
}

function CopyTextButton({
  text,
  label,
  title,
  iconOnly,
}: {
  text: string;
  label: string;
  title?: string;
  iconOnly?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      size="sm"
      variant="ghost"
      className="h-6 px-2 text-[11px]"
      title={title ?? `Copy ${label}`}
      aria-label={title ?? `Copy ${label}`}
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1200);
        });
      }}
    >
      {copied ? "Copied" : iconOnly ? <Copy className="size-3" /> : label}
    </Button>
  );
}
