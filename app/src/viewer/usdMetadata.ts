/**
 * The IFC metadata the converter authors into the layer, surfaced for the prim
 * inspector.
 *
 * WHY A CAPTURE RATHER THAN A SECOND PARSE
 * ----------------------------------------
 * `usd-convert-cad --convert-metadata` writes
 * `omni:hoops:metadata:<IFCTYPE>:<field>` onto every element prim — GlobalId,
 * Tag (the Revit element id), Name, PredefinedType and every pset value — but
 * none of it reaches a picked mesh. `USDComposer.compose()` keeps the parsed
 * layer in `this.specsByPath` on an instance that `USDLoader.parse()` creates
 * internally and never hands out, and three exposes no accessor for it.
 *
 * So we wrap the one seam this module controls: `USDAParser.parseData`, which
 * the loader calls for the root layer, and keep what comes back. Re-parsing the
 * 46 MB layer per click costs ~9 s of main thread; a sidecar JSON would be a
 * second source of truth that can drift away from the flatten it describes.
 * This costs one guarded wrap and degrades to "no metadata rows" if three's
 * internals move — never a throw.
 *
 * SPEC SHAPE (measured against three's own parser: 60 189 specs)
 * -------------------------------------------------------------
 *   /House/…/IFCWALL/tn__BasicWall…                      -> {specType: 6, …}   prim
 *   /House/…/tn__BasicWall….uniform string omni:hoops:metadata:IFCWALL:GlobalId
 *                                                        -> {specType: 1, fields: {default, typeName}}
 *   /House/…/tn__BasicWall….rel omni:hoops:metadata:bim:… -> specType 8         relationship
 *
 * i.e. an attribute hangs off its prim's path with `.<declaration>` appended,
 * and the declaration's last token is the attribute name (names carry no
 * spaces, which is also what separates a relationship key from an attribute
 * one).
 */

const PREFIX = "omni:hoops:metadata:";

// The SAME module the loader imports (`USDLoader.js` → `./usd/USDAParser.js`),
// so this patches the class instance it will actually construct.
// @ts-ignore @types/three ships USDLoader.d.ts but has no declaration for
// usd/USDAParser.js (the file only exists in three/examples/jsm/loaders/usd/).
import { USDAParser } from "three/examples/jsm/loaders/usd/USDAParser.js";

interface Spec {
  specType?: number;
  fields?: Record<string, unknown>;
}

type Rows = Map<string, string>;
/** prim path -> (attribute name without the HOOPS prefix -> value) */
type Index = Map<string, Rows>;

const indexes: Index[] = [];
let installed = false;

function buildIndex(specsByPath: Record<string, Spec>): Index {
  const index: Index = new Map();
  for (const key of Object.keys(specsByPath)) {
    const prefixAt = key.indexOf(PREFIX);
    if (prefixAt < 0) continue;
    const spec = specsByPath[key];
    if (spec?.specType !== 1) continue; // attributes only: skip prims and rels
    const dot = key.indexOf(".");
    if (dot < 0 || dot > prefixAt) continue;
    const name = key.slice(prefixAt);
    if (/\s/.test(name)) continue; // a relationship declaration, not a name
    const raw = spec.fields?.default;
    if (raw === undefined || raw === null) continue;
    const primPath = key.slice(0, dot);
    let row = index.get(primPath);
    if (!row) {
      row = new Map();
      index.set(primPath, row);
    }
    row.set(
      name.slice(PREFIX.length),
      Array.isArray(raw) ? raw.map(String).join(", ") : String(raw),
    );
  }
  return index;
}

/**
 * Wrap `USDAParser.parseData` once so every layer the loader parses is indexed.
 * Idempotent, and a no-op if three has changed the shape we rely on.
 */
export function installMetadataCapture(): void {
  if (installed) return;
  installed = true;
  try {
    const proto = USDAParser.prototype as unknown as {
      parseData: (text: string) => unknown;
    };
    const original = proto.parseData;
    if (typeof original !== "function") return;
    proto.parseData = function (this: unknown, text: string): unknown {
      const out = original.call(this, text) as
        | { specsByPath?: Record<string, Spec> }
        | undefined;
      const specs = out?.specsByPath;
      if (specs && typeof specs === "object") indexes.push(buildIndex(specs));
      return out;
    };
  } catch {
    // three moved on: the panel simply shows geometry, as it did before.
  }
}

/** Test/inspection hook — how many layers have been indexed. */
export function capturedLayerCount(): number {
  return indexes.length;
}

export interface PrimMetadata {
  /** Every IFC field the layer carries for the nearest prim that has any. */
  rows: Record<string, string>;
  /**
   * The element's own GlobalId — `TYPE:GlobalId` fields (IFCWALLTYPE, …) are
   * the IfcTypeObject's id, which is why they are only used as a fallback.
   */
  globalId?: string;
}

/**
 * Resolve the metadata for a prim path, walking up until a prim that carries
 * some is found: a picked object is a Mesh, while the fields live on its
 * element parent (`…/IFCWALL/tn__BasicWall…/Mesh`).
 */
export function readMetadata(path: string): PrimMetadata {
  const empty: PrimMetadata = { rows: {} };
  if (!path || indexes.length === 0) return empty;

  let current = path;
  for (;;) {
    for (const index of indexes) {
      const row = index.get(current);
      if (!row || row.size === 0) continue;
      const rows: Record<string, string> = {};
      for (const [k, v] of row) rows[k] = v;
      let globalId: string | undefined;
      for (const [k, v] of row) {
        if (!k.endsWith(":GlobalId")) continue;
        if (k.endsWith("TYPE:GlobalId")) {
          globalId ??= v; // keep the type's as a fallback only
        } else {
          globalId = v;
          break;
        }
      }
      return globalId === undefined ? { rows } : { rows, globalId };
    }
    const cut = current.lastIndexOf("/");
    if (cut <= 0) break;
    current = current.slice(0, cut);
  }
  return empty;
}
