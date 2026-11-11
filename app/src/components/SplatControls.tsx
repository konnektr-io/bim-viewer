/**
 * Sliders for placing the Gaussian-splat overlay in the house.
 *
 * Why this exists at all: the splat cannot be fitted automatically. Measured on
 * this capture, anchoring length by the room area (63 m2) gives 0.539 m/unit
 * while anchoring height by the 2.5 m ceiling gives 0.781 m/unit — the
 * reconstruction is 1.45x anisotropic, so no similarity transform fits it and
 * every "auto-fit" bottoms out metres off. Those four-ish numbers are simply not
 * derivable from the data; they are judgeable in seconds by the person who knows
 * the room. So the tool exposes them directly and reports them back as text that
 * can be baked into the USD.
 */
import { useCallback, useEffect, useState } from "react";

import type { SplatTransform } from "@/viewer/splatLayer";
import { CollapsiblePanel } from "@/components/CollapsiblePanel";

interface EngineLike {
  getSplatStatus(): { url: string; splatCount: number; transform: SplatTransform } | null;
  setSplatTransform(patch: Partial<SplatTransform>): SplatTransform | null;
}

const FIELDS: {
  key: keyof SplatTransform;
  label: string;
  min: number;
  max: number;
  step: number;
}[] = [
  { key: "scaleX", label: "scale X", min: 0.01, max: 3, step: 0.005 },
  { key: "scaleY", label: "scale Y", min: 0.01, max: 3, step: 0.005 },
  { key: "scaleZ", label: "scale Z", min: 0.01, max: 3, step: 0.005 },
  { key: "yawDeg", label: "yaw °", min: -180, max: 180, step: 0.5 },
  { key: "tx", label: "move X", min: -30, max: 30, step: 0.05 },
  { key: "ty", label: "move Y", min: -30, max: 30, step: 0.05 },
  { key: "tz", label: "move Z", min: -30, max: 30, step: 0.05 },
];

function engine(): EngineLike | null {
  const w = window as unknown as { __usdEngine?: EngineLike };
  return w.__usdEngine ?? null;
}

export function SplatControls() {
  const [status, setStatus] = useState<{ url: string; splatCount: number } | null>(null);
  const [transform, setTransform] = useState<SplatTransform | null>(null);

  // The splat loads asynchronously from a URL param, so poll for it rather than
  // threading a store through the engine's callbacks.
  useEffect(() => {
    let cancelled = false;
    const tick = (): void => {
      const s = engine()?.getSplatStatus() ?? null;
      if (!cancelled) {
        setStatus(s ? { url: s.url, splatCount: s.splatCount } : null);
        if (s) setTransform(s.transform);
      }
    };
    tick();
    const id = window.setInterval(tick, 750);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  const update = useCallback((key: keyof SplatTransform, value: number) => {
    const next = engine()?.setSplatTransform({ [key]: value } as Partial<SplatTransform>);
    if (next) setTransform(next);
  }, []);

  const copyUrl = useCallback(() => {
    if (!transform) return;
    const p = new URLSearchParams();
    p.set("splat", status?.url ?? "");
    p.set("sx", transform.scaleX.toFixed(4));
    p.set("sy", transform.scaleY.toFixed(4));
    p.set("sz", transform.scaleZ.toFixed(4));
    p.set("yaw", transform.yawDeg.toFixed(2));
    p.set("tx", transform.tx.toFixed(3));
    p.set("ty", transform.ty.toFixed(3));
    p.set("tz", transform.tz.toFixed(3));
    void navigator.clipboard?.writeText(`${window.location.origin}/?${p.toString()}`);
  }, [status, transform]);

  if (!status || !transform) return null;

  return (
    <CollapsiblePanel id="splat" title="Splat overlay" testId="panel-splat">
      <div className="space-y-2">
        <div className="text-xs text-muted-foreground">
          {status.splatCount.toLocaleString("en-US")} splats · {status.url.split("/").pop()}
        </div>
        {FIELDS.map((f) => (
          <label key={f.key} className="block">
            <span className="flex items-baseline justify-between text-xs">
              <span className="text-muted-foreground">{f.label}</span>
              <span className="font-mono tabular-nums">{transform[f.key].toFixed(3)}</span>
            </span>
            <input
              type="range"
              min={f.min}
              max={f.max}
              step={f.step}
              value={transform[f.key]}
              onChange={(e) => update(f.key, Number(e.target.value))}
              className="w-full"
              data-testid={`splat-${f.key}`}
            />
          </label>
        ))}
        <button
          type="button"
          onClick={copyUrl}
          className="mt-1 w-full rounded border border-border px-2 py-1 text-xs hover:bg-accent"
          data-testid="splat-copy"
        >
          Copy URL with this transform
        </button>
      </div>
    </CollapsiblePanel>
  );
}
