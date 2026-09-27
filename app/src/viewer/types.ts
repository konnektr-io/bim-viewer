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

export interface Selection {
  localId: number;
  category: string;
  name: string | null;
  guid: string | null;
  room: string | null;
  circuit: CircuitPset | null;
}

export type LoadStatus =
  | { state: "idle" }
  | { state: "loading"; detail: string }
  | { state: "ready"; elementCount: number; spaceCount: number; storeyCount: number }
  | { state: "error"; message: string };

export type Format = "ifc" | "usd";
