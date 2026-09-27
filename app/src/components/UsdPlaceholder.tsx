import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * Placeholder for the USD view.
 *
 * Not an empty stub — it records WHY the USD view cannot simply be switched on,
 * because the house USD is a reference-only composition that no browser loader
 * can traverse. See the repo README.
 */
export function UsdPlaceholder() {
  return (
    <div className="grid h-full place-items-center p-6">
      <Card className="max-w-2xl">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            USD view
            <Badge variant="secondary">planned</Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm text-muted-foreground">
          <p>
            The USD for this house is not a standalone model but a{" "}
            <strong className="text-foreground">reference-only layer stack</strong>:
          </p>
          <ul className="list-disc space-y-1 pl-5">
            <li>
              The scene entry point is 910 bytes and contains only{" "}
              <code className="font-mono text-xs">subLayers</code> — no geometry.
            </li>
            <li>
              It references absolute local paths{" "}
              <code className="font-mono text-xs">/opt/data/cad/…</code> that do not exist in a
              browser.
            </li>
            <li>
              The real geometry lives in the leaf layer{" "}
              <code className="font-mono text-xs">house_noinst.usda</code> (52.5 MB,{" "}
              <code className="font-mono text-xs">metersPerUnit = 0.001</code>, 55 Mesh prims).
            </li>
          </ul>
          <p>
            three.js <code className="font-mono text-xs">USDLoader</code> follows neither{" "}
            <code className="font-mono text-xs">subLayers</code> nor{" "}
            <code className="font-mono text-xs">references</code>, so it cannot render this file. A{" "}
            <strong className="text-foreground">flattening step</strong> is needed first: compose
            the layer stack into one self-contained{" "}
            <code className="font-mono text-xs">.usd</code>, rewrite the paths to
            proxy-relative URLs, and scale mm → m.
          </p>
          <p>
            Also still empty: <code className="font-mono text-xs">garden.usda</code> and{" "}
            <code className="font-mono text-xs">hifi_assets.usda</code> are deliberate empty
            placeholders, so the current scene is shell + bathroom.
          </p>
          <Button variant="secondary" size="sm" onClick={() => window.location.reload()}>
            Back to IFC
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
