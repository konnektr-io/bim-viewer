import { useViewerStore } from "@/store/viewerStore";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { CIRCUIT_LABELS } from "@/viewer/labels";

/** Detail panel for the current pick: what it is, which room, which circuit. */
export function SelectionDetail() {
  const selection = useViewerStore((s) => s.selection);
  if (!selection) return null;

  // Keep only the properties that are actually present on this element.
  const circuitRows: Array<{ key: string; label: string; value: string }> = [];
  for (const [key, label] of CIRCUIT_LABELS) {
    const value = selection.circuit?.[key];
    if (value !== undefined) circuitRows.push({ key, label, value });
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-xs uppercase tracking-wider text-muted-foreground">
          Selectie
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-1 text-sm">
        <Row label="Categorie" value={selection.category} />
        {selection.name ? <Row label="Naam" value={selection.name} /> : null}
        <Row label="Ruimte" value={selection.room ?? "—"} />
        {selection.guid ? (
          <Row label="GlobalId" value={selection.guid} mono />
        ) : null}

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
      </CardContent>
    </Card>
  );
}

function Row({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="grid grid-cols-[7rem_1fr] gap-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={mono ? "font-mono text-xs break-all" : "break-words"}>{value}</dd>
    </div>
  );
}
