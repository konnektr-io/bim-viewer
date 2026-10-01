/**
 * Types for the USD view.
 *
 * The manifest is produced at build time by pxr (`cad/build_web_usd.py`) and
 * served from `/api/usd/manifest`. The layer / storey / category grouping is
 * computed there because after flattening a root prim is just a name — the
 * sublayer structure that made those groups meaningful no longer exists in the
 * file the browser downloads.
 */

/** One toggleable layer: a root prim, with the sublayer that contributed it. */
export interface UsdLayer {
  id: string;
  label: string;
  /** The layer this root prim's geometry came from, for display. */
  sublayer: string;
  meshCount: number;
}

/** A storey (an IFC path segment) and how many meshes sit in it. */
export interface UsdGroup {
  id: string;
  label: string;
  meshCount: number;
}

export interface UsdManifest {
  generatedFrom: string;
  generatedAt: string;
  slug: string;
  /** Filename of the flattened layer, relative to the USD directory. */
  file: string;
  sha256: string;
  bytesRaw: number;
  bytesGzip: number;
  defaultPrim: string | null;
  upAxis: string;
  metersPerUnit: number;
  meshCount: number;
  /** Metres. */
  bbox: { min: number[]; max: number[]; size: number[] };
  layers: UsdLayer[];
  storeys: UsdGroup[];
  categories: UsdGroup[];
  /** Optional display title; the backend may not send one. */
  title?: string;
}

/** What a prim path encodes about the IFC element behind it. */
export interface UsdIfcPathInfo {
  /** Path segment 5 of the IFC-derived prims, e.g. `S_Funderingsplaat`. */
  storey: string | null;
  /** Path segment 6, e.g. `IFCWALL`, `IFCSPACE`, `IFCFLOWSEGMENT`. */
  category: string | null;
  /** Room name when the path carries one, else null. */
  room: string | null;
  /** The element's own name segment. */
  element: string | null;
}

/** One picked prim. */
export interface UsdPrimInfo {
  /** The full USD prim path — the only stable identity the format carries. */
  path: string;
  rootPrim: string;
  name: string;
  ifc: UsdIfcPathInfo;
  /**
   * Geometry facts and the material name, plus every
   * `omni:hoops:metadata:*` field the converter authored for the element this
   * prim belongs to — `IFCWALL:GlobalId`, `IFCWALL:Tag`, psets, …
   */
  attributes: Record<string, string>;
  /**
   * The element's own IFC GlobalId, lifted out of `attributes` so the panel can
   * show it alongside the other identifiers. Absent when the layer predates
   * `--convert-metadata`, or when the prim carries no GlobalId at all.
   */
  globalId?: string;
}

export type UsdLoadStatus =
  | { state: "idle" }
  | { state: "loading"; detail: string }
  | { state: "ready"; meshCount: number; layerCount: number }
  | { state: "error"; message: string };
