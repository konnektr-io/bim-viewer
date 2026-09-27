/**
 * Shared types for the viewer.
 *
 * The ThatOpen Fragments payloads are only partly typed upstream, so the shapes
 * we actually read are declared here rather than spread across the app.
 */

/** A property set as it comes back from `getItemsData`, still value-wrapped. */
export type RawAttribute = { value: unknown; type?: string };

/**
 * Fragments wraps every attribute as `{ value, type? }`, sometimes nested
 * (`NominalValue.value`). Unwrap recursively.
 */
export function unwrap(raw: unknown): unknown {
  if (raw === null || raw === undefined) return undefined;
  if (typeof raw === "object" && !Array.isArray(raw) && "value" in raw) {
    return unwrap((raw as { value: unknown }).value);
  }
  return raw;
}

/** One element as returned by `getItemsData`. */
export interface ItemData {
  _category?: RawAttribute;
  _localId?: RawAttribute;
  _guid?: RawAttribute;
  Name?: RawAttribute;
  LongName?: RawAttribute;
  PredefinedType?: RawAttribute;
  HasProperties?: unknown;
  [key: string]: unknown;
}

export interface Storey {
  localId: number;
  /** LongName when present, else Name, else a localId fallback. */
  name: string;
  /** Number of elements on this storey. 0 is legitimate (A_Kelder). */
  elementCount: number;
}

export interface Room {
  localId: number;
  name: string;
  elementCount: number;
}

/** Pset_ElectricalCircuit, keyed by its real property names. */
export type CircuitPset = Record<string, string>;

/** One property set / quantity set, as extracted from the fragments payload. */
export interface PropertySet {
  /** Real IFC set name, e.g. `Pset_ElectricalCircuit` or `Qto_WallBaseQuantities`. */
  name: string;
  /**
   * `pset` for `IfcPropertySet`, `qto` for `IfcElementQuantity`, `type` for a
   * set that is only defined on the element's type object.
   */
  kind: "pset" | "qto" | "type";
  /** The set's own `_localId` in the model, for diagnostics and quoting. */
  localId: number | null;
  /** Flattened `property name -> value`, in payload order. */
  properties: Record<string, string>;
}

/** One material layer: material name plus thickness when the model carries it. */
export interface MaterialLayer {
  name: string;
  thickness: string | null;
}

export interface Selection {
  localId: number;
  category: string;
  name: string | null;
  guid: string | null;
  room: string | null;
  circuit: CircuitPset | null;
  /**
   * Every property set on the occurrence AND on its type object, in payload
   * order. `Pset_ElectricalCircuit` is also mirrored on `circuit` for the
   * labelled rows.
   */
  propertySets: PropertySet[];
  /** Material layers (IfcMaterialLayerSet), empty when the element has none. */
  materialLayers: MaterialLayer[];
  /** Name of the material layer set, e.g. the wall build-up. */
  materialLayerSetName: string | null;
  /** Name of the IfcType the element is defined by, when present. */
  typeName: string | null;
  /**
   * Every scalar attribute the fragments payload carried, flattened to
   * `Name -> value`. Needed to inspect elements the viewer has no special
   * handling for, and to quote exact values when requesting model edits.
   */
  attributes: Record<string, string>;
}

export type LoadStatus =
  | { state: "idle" }
  | { state: "loading"; detail: string }
  | { state: "ready"; elementCount: number; spaceCount: number; storeyCount: number }
  | { state: "error"; message: string };

export type Format = "ifc" | "usd";

/** Served by the backend from its own configuration, so no project name is in the frontend. */
export interface ModelConfig {
  /** Filename to fetch from /api/model/{slug} */
  modelSlug: string;
  /** Display name for the header */
  modelTitle: string;
}
