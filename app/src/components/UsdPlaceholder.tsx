import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * Placeholder for the USD view.
 *
 * Not an empty stub — it records WHY the USD view cannot simply be switched on,
 * because the house USD is a reference-only composition that no browser loader
 * can traverse. See bim-viewer/README.md.
 */
export function UsdPlaceholder() {
  return (
    <div className="grid h-full place-items-center p-6">
      <Card className="max-w-2xl">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            USD-weergave
            <Badge variant="secondary">gepland</Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm text-muted-foreground">
          <p>
            De USD voor deze woning is geen zelfstandig model maar een{" "}
            <strong className="text-foreground">referentie-only laagstapel</strong>:
          </p>
          <ul className="list-disc space-y-1 pl-5">
            <li>
              <code className="font-mono text-xs">achterhekers57.usd</code> is 910 bytes en
              bevat alleen <code className="font-mono text-xs">subLayers</code> — geen geometrie.
            </li>
            <li>
              De laag verwijst naar absolute lokale paden{" "}
              <code className="font-mono text-xs">/opt/data/cad/…</code> die in een browser niet
              bestaan.
            </li>
            <li>
              De werkelijke geometrie zit in het blad{" "}
              <code className="font-mono text-xs">house_noinst.usda</code> (52,5 MB,{" "}
              <code className="font-mono text-xs">metersPerUnit = 0.001</code>, 55 Mesh-prims).
            </li>
          </ul>
          <p>
            three.js <code className="font-mono text-xs">USDLoader</code> volgt geen{" "}
            <code className="font-mono text-xs">subLayers</code> of{" "}
            <code className="font-mono text-xs">references</code>, dus die kan dit bestand niet
            renderen. Er is eerst een <strong className="text-foreground">flatten-stap</strong> nodig:
            de laagstapel samenvoegen tot één zelfstandig <code className="font-mono text-xs">.usd</code>,
            de paden naar proxy-URL&apos;s herschrijven, en mm → m schalen.
          </p>
          <p>
            Ook nog leeg: <code className="font-mono text-xs">garden.usda</code> en{" "}
            <code className="font-mono text-xs">hifi_assets.usda</code> zijn bewust lege
            placeholders. De huidige scène is dus schil + badkamer.
          </p>
          <Button variant="secondary" size="sm" onClick={() => window.location.reload()}>
            Terug naar IFC
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
