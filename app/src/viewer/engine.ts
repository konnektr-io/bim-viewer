/**
 * The ThatOpen engine.
 *
 * This is deliberately NOT a React component. `Components.init()` owns a render
 * loop, the scene and the highlighter are long-lived mutable objects, and
 * re-running them through React's render cycle would tear the world down on
 * every state change. React owns the UI; this module owns the 3D scene and
 * reports back through callbacks.
 */
import * as OBC from "@thatopen/components";
import * as OBF from "@thatopen/components-front";
import type { FragmentsModel, MeshData } from "@thatopen/fragments";
import * as THREE from "three";

import {
  type CircuitPset,
  type ItemData,
  type MaterialLayer,
  type PropertySet,
  type Room,
  type Selection,
  type Storey,
  unwrap,
} from "./types";
import { VIEW_PRESETS, type ViewPreset } from "./viewPresets";
import { FACE_DIRECTIONS, ViewCube, type CubeFace } from "./viewCube";
import { SectionPlane, type SectionState } from "./sectionPlane";
import { CIRCUIT_LABELS } from "./labels";
import type { ModelConfig } from "./types";

export type { ViewPreset };

const WASM_PATH = "/wasm/";

/** The concrete world shape this engine builds. */
type ViewerWorld = OBC.SimpleWorld<OBC.SimpleScene, OBC.SimpleCamera, OBC.SimpleRenderer>;

export interface EngineCallbacks {
  onProgress?: (detail: string) => void;
  onReady?: (info: {
    elementCount: number;
    storeys: Storey[];
    rooms: Room[];
  }) => void;
  onSelection?: (selection: Selection | null) => void;
  onError?: (message: string) => void;
}

const asString = (value: unknown): string | null => {
  const v = unwrap(value);
  if (v === undefined || v === null || v === "") return null;
  return String(v);
};

/** Read a single wrapped value key, e.g. `NominalValue` or `LengthValue`. */
function propText(entry: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    if (!(key in entry)) continue;
    const text = asString(entry[key]);
    if (text !== null) return text;
  }
  return null;
}

/**
 * Flatten one `IfcPropertySet.HasProperties` entry to `name -> value`.
 *
 * Handles `IfcPropertySingleValue` (`NominalValue`), enumerated values
 * (`EnumerationValues`), list values (`ListValues`) and bounded values
 * (`LowerBoundValue` / `UpperBoundValue`). Entries without a name or without
 * any readable value are skipped so empty rows never reach the panel.
 */
function readPsetEntry(entry: unknown): [string, string] | null {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
  const record = entry as Record<string, unknown>;
  const key = asString(record.Name);
  if (!key) return null;
  const value = propText(
    record,
    "NominalValue",
    "UnitBasedValue",
    "EnumerationValues",
    "ListValues",
    "LowerBoundValue",
    "UpperBoundValue",
  );
  if (value === null) return null;
  return [key, tidyValue(value)];
}

/**
 * Flatten one `IfcElementQuantity.Quantities` entry to `name -> value`.
 *
 * Quantity kinds carry different value keys (`LengthValue`, `AreaValue`,
 * `VolumeValue`, `CountValue`, `WeightValue`, `TimeValue`), so try them all.
 */
function readQuantityEntry(entry: unknown): [string, string] | null {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
  const record = entry as Record<string, unknown>;
  const key = asString(record.Name);
  if (!key) return null;
  const value = propText(
    record,
    "LengthValue",
    "AreaValue",
    "VolumeValue",
    "CountValue",
    "WeightValue",
    "TimeValue",
    "NominalValue",
  );
  if (value === null) return null;
  return [key, tidyValue(value)];
}

/**
 * Unwrap a payload value and return it as an array.
 *
 * Aggregates arrive either as a plain array or wrapped as `{value: […]}`,
 * depending on the path they were reached through, so both are accepted.
 */
function asArray(value: unknown): unknown[] {
  const v = unwrap(value);
  return Array.isArray(v) ? v : [];
}

/** A payload value as a plain object, or null when it is a scalar or array. */
function asRecord(value: unknown): Record<string, unknown> | null {
  const v = unwrap(value);
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  return v as Record<string, unknown>;
}

/** A payload node's `_category`, upper-cased (`IFCPROPERTYSET`), or "". */
function nodeCategory(node: Record<string, unknown>): string {
  return (asString(node._category) ?? "").toUpperCase();
}

/** A payload node's `_localId` as a number, or null. */
function nodeLocalId(node: Record<string, unknown>): number | null {
  const id = unwrap(node._localId);
  return typeof id === "number" ? id : null;
}

/**
 * Trim the trailing float noise IFC measures carry.
 *
 * `Length = 3118.726962500003` and `ThermalTransmittance = 17.88888888888889`
 * are unreadable in a narrow column, and nothing in this panel needs 15
 * decimals. Four SIGNIFICANT figures, not four decimal places: a cross-section
 * area of 0.0063608 m² must not collapse to 0.0064. Only plain numeric values
 * are touched — ids, guids and labels are strings and pass through untouched.
 */
function tidyValue(text: string): string {
  if (!/^-?\d+\.\d+$/.test(text)) return text;
  const value = Number.parseFloat(text);
  if (!Number.isFinite(value)) return text;
  const trimmed = Math.abs(value) >= 1 ? value.toFixed(4) : value.toPrecision(4);
  return String(Number(trimmed));
}

/** One property set as read off a payload node, before merging. */
interface RawSet {
  name: string;
  kind: PropertySet["kind"];
  localId: number | null;
  properties: Record<string, string>;
}

/**
 * Read one property-set node (`IfcPropertySet` or `IfcElementQuantity`).
 *
 * A node reached through the element's relations carries `HasProperties` (a
 * property set) or `Quantities` (a quantity set). Its `Name` is WRAPPED
 * (`{value: "Pset_…", type: "IFCLABEL"}`): comparing that to a raw string is
 * exactly the bug that made the panel render no sets at all.
 */
function readSetNode(node: Record<string, unknown>): RawSet | null {
  const name = asString(node.Name);
  if (!name) return null;
  const isQuantity = nodeCategory(node) === "IFCELEMENTQUANTITY" || name.startsWith("Qto_");
  const properties: Record<string, string> = {};
  for (const entry of asArray(isQuantity ? node.Quantities : node.HasProperties)) {
    const pair = isQuantity ? readQuantityEntry(entry) : readPsetEntry(entry);
    if (pair) properties[pair[0]] = pair[1];
  }
  return {
    name,
    kind: isQuantity ? "qto" : "pset",
    localId: nodeLocalId(node),
    properties,
  };
}

/**
 * Every property set and quantity set on an element, plus its type object.
 *
 * Measured on this model (13 493 elements, IFC4X3 Revit export), because none
 * of this is guessable from the API:
 *
 * - the sets hang off the element's `IsDefinedBy`, and the traversal
 *   (`IsDefinedBy: { attributes: true, relations: true }`) is what brings their
 *   `HasProperties` / `Quantities` along. Fetching a set by its own localId
 *   returns a NAME-ONLY stub unless relations are requested for it;
 * - the element's type object arrives as one more `IsDefinedBy` entry
 *   (`_category: "IFCPIPESEGMENTTYPE"`); `IsTypedBy` does not exist as a
 *   relation tag in this model at all;
 * - a type's own sets hang off its `HasPropertySets` attribute and arrive as
 *   stubs, so they are fetched by id afterwards;
 * - `DefinesOccurrence` and `ObjectTypeOf` point back at every SIBLING element,
 *   so the paths are read explicitly instead of walking the graph. A blind walk
 *   drags other elements' property sets in and merges their values into this
 *   one — 57 pipes share one `IfcPipeSegmentType`.
 */
async function collectPropertySets(
  model: FragmentsModel,
  item: ItemData,
): Promise<{ sets: PropertySet[]; typeName: string | null }> {
  const merged = new Map<string, PropertySet>();
  const order: string[] = [];
  const stubs: number[] = [];
  const typeSets: RawSet[] = [];
  let typeName: string | null = null;

  // Keyed by set name: Revit attaches the same `Pset_*TypeCommon` entity to both
  // the type and the occurrence, and that must render as ONE group. The kind is
  // whichever path reached it FIRST — the element's own sets are recorded before
  // the type's, so `(type)` really means "only the type object carries this".
  const record = (set: RawSet, kindOverride?: PropertySet["kind"]): void => {
    const existing = merged.get(set.name);
    if (existing) {
      for (const [key, value] of Object.entries(set.properties)) {
        if (!(key in existing.properties)) existing.properties[key] = value;
      }
      if (existing.localId === null && set.localId !== null) existing.localId = set.localId;
      return;
    }
    merged.set(set.name, {
      name: set.name,
      kind: kindOverride ?? set.kind,
      localId: set.localId,
      properties: { ...set.properties },
    });
    order.push(set.name);
  };

  for (const node of asArray((item as Record<string, unknown>).IsDefinedBy)) {
    const rec = asRecord(node);
    if (!rec) continue;
    const category = nodeCategory(rec);

    if (category.endsWith("TYPE")) {
      if (typeName === null) typeName = asString(rec.Name);
      for (const sub of asArray(rec.HasPropertySets)) {
        const subRec = asRecord(sub);
        if (!subRec) continue;
        const set = readSetNode(subRec);
        if (!set) continue;
        if (Object.keys(set.properties).length === 0 && set.localId !== null) stubs.push(set.localId);
        typeSets.push(set);
      }
      continue;
    }

    if (category === "IFCPROPERTYSET" || category === "IFCELEMENTQUANTITY") {
      const set = readSetNode(rec);
      if (!set) continue;
      if (Object.keys(set.properties).length === 0 && set.localId !== null) stubs.push(set.localId);
      record(set);
    }
  }

  // The type's sets go in second, and only keep the `type` kind when nothing on
  // the element itself already declared that set.
  for (const set of typeSets) record(set, "type");

  // Type-object sets arrived as stubs; fetch them so their values show too.
  if (stubs.length > 0) {
    try {
      const extra = await model.getItemsData([...new Set(stubs)], {
        attributesDefault: true,
        relationsDefault: { attributes: true, relations: true },
      });
      for (const node of extra) {
        const rec = asRecord(node);
        if (!rec) continue;
        const set = readSetNode(rec);
        if (set) record(set);
      }
    } catch (err) {
      // A missing set is not worth failing the whole selection over.
      console.warn("Could not load the type object's property sets", err);
    }
  }

  return { sets: order.map((name) => merged.get(name)!), typeName };
}

/** `Pset_ElectricalCircuit`, for the hand-labelled rows at the top. */
function findCircuitPset(sets: PropertySet[]): CircuitPset | null {
  const found = sets.find((set) => set.name === "Pset_ElectricalCircuit");
  return found ? { ...found.properties } : null;
}

/**
 * Material layers from `HasAssociations` (`IfcMaterialLayerSet` ->
 * `IfcMaterialLayer`).
 *
 * The layer's own `Name` is the MATERIAL name (`BERSnl_21_baksteen_…`) and
 * `LayerThickness` its thickness in the file's unit. `AssociatedTo` on the same
 * node lists every element sharing that layer set (11 walls here), so it is
 * deliberately not walked. A bare `IfcMaterial` or a profile set yields one
 * entry without a thickness.
 */
function collectMaterialLayers(item: ItemData): { layers: MaterialLayer[]; setName: string | null } {
  const layers: MaterialLayer[] = [];
  const seen = new Set<string>();
  let setName: string | null = null;

  const add = (name: string, thickness: string | null): void => {
    const key = `${name}#${thickness ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    layers.push({ name, thickness });
  };

  for (const node of asArray((item as Record<string, unknown>).HasAssociations)) {
    const rec = asRecord(node);
    if (!rec) continue;
    const category = nodeCategory(rec);

    if (category === "IFCMATERIALLAYERSET" || category === "IFCMATERIALLAYERSETUSAGE") {
      setName = setName ?? asString(rec.LayerSetName) ?? asString(rec.Name);
      // A usage wraps the set it points at; a plain set is the set.
      const target = asRecord(rec.ForLayerSet) ?? rec;
      for (const entry of asArray(target.MaterialLayers)) {
        const layer = asRecord(entry);
        if (!layer) continue;
        const name = asString(layer.Name);
        if (name) add(name, asString(layer.LayerThickness));
      }
      continue;
    }

    if (
      category === "IFCMATERIAL" ||
      category === "IFCMATERIALPROFILESET" ||
      category === "IFCMATERIALPROFILE"
    ) {
      const name = asString(rec.Name);
      if (name) add(name, null);
    }
  }

  return { layers, setName };
}

/**
 * Flatten an item's own scalar attributes into `Name -> value`.
 *
 * Only the TOP level of the payload is read, and internal keys (the ones the
 * fragments library prefixes with `_`) are skipped: they are bookkeeping, not
 * model data, and showing them buries the attributes you actually want. Nested
 * values are rendered as a short summary rather than walked, so this stays
 * cheap and cannot recurse.
 */
function collectAttributes(item: ItemData): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(item as unknown as Record<string, unknown>)) {
    if (key.startsWith("_")) continue;
    if (value === null || value === undefined) continue;
    if (typeof value === "object") {
      const label = asString((value as Record<string, unknown>).Name ?? (value as Record<string, unknown>).value);
      if (label) out[key] = label;
      continue;
    }
    const text = asString(value);
    if (text !== null) out[key] = text;
  }
  return out;
}

export class ViewerEngine {
  private components: OBC.Components | null = null;
  private fragments: OBC.FragmentsManager | null = null;
  private model: FragmentsModel | null = null;
  private world: ViewerWorld | null = null;
  private viewCube: ViewCube | null = null;
  private sectionPlane: SectionPlane | null = null;

  private allIds: number[] = [];
  /** element localId -> enclosing room localId */
  private elementToRoom = new Map<number, number>();
  private roomNames = new Map<number, string>();
  private storeyNames = new Map<number, string>();
  private storeyElements = new Map<number, number[]>();
  private roomElements = new Map<number, number[]>();
  /** Size of the box the camera was last framed on — diagnostics only. */
  private lastFramedSize: [number, number, number] | null = null;
  /** How many element boxes the framing rejected as outliers — diagnostics. */
  private outlierCount: number | null = null;
  /** The bounds the view presets orbit around. */
  private lastBounds: THREE.Box3 | null = null;
  /** Currently active storey filter, or null for the whole model. */
  private activeStorey: number | null = null;
  /** Last reported selection, kept for the headless diagnostics probe. */
  private lastSelection: Selection | null = null;
  /** Storey-band box, kept for diagnostics. */
  private storeyBoxForDiag: THREE.Box3 | null = null;
  /** Which branch computeBounds took, and why — diagnostics. */
  private boundsTrace: Record<string, unknown> = {};
  /** Model slug + title, fetched from the backend so nothing is hardcoded here. */
  private config: ModelConfig | null = null;

  // Plain field, not a constructor parameter property: `erasableSyntaxOnly`
  // (inherited from the graph-explorer tsconfig) forbids emit-only syntax.
  private readonly callbacks: EngineCallbacks;

  constructor(callbacks: EngineCallbacks = {}) {
    this.callbacks = callbacks;
  }

  async load(container: HTMLElement): Promise<void> {
    try {
      await this.initWorld(container);
      await this.initFragments();
      await this.fetchAndConvert();
      await this.indexModel();
      this.initPicking();
      container.style.visibility = "visible";
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.callbacks.onError?.(message);
      throw err;
    }
  }

  // ---------------------------------------------------------------- world

  private async initWorld(container: HTMLElement): Promise<void> {
    const components = new OBC.Components();
    this.components = components;

    const worlds = components.get(OBC.Worlds);
    const world = worlds.create<OBC.SimpleScene, OBC.SimpleCamera, OBC.SimpleRenderer>();
    this.world = world;
    world.scene = new OBC.SimpleScene(components);
    world.scene.setup();
    world.scene.three.background = new THREE.Color(0x0b111d);

    world.renderer = new OBC.SimpleRenderer(components, container);
    world.camera = new OBC.SimpleCamera(components);

    components.init();

    // The view cube mirrors the main camera every time the controls update, so
    // it tracks orbiting and panning without a render loop of its own.
    const cube = new ViewCube({
      size: 128,
      onSelect: (face) => {
        void this.lookFromFace(face);
      },
    });
    this.viewCube = cube;
    container.append(cube.element);
    const controls = world.camera.controls;
    controls?.addEventListener("update", () => {
      cube.updateOrientation(world.camera.three);
    });
  }

  private async initFragments(): Promise<void> {
    const { components, world } = this;
    if (!components || !world) throw new Error("World not initialised");

    const fragments = components.get(OBC.FragmentsManager);
    this.fragments = fragments;

    // The worker must match the installed @thatopen/fragments build; the
    // library resolves that itself. Passing any other URL is a schema mismatch.
    fragments.init(await OBC.FragmentsManager.getWorker());

    // SimpleCamera.controls is typed as optional on the base camera.
    const controls = world.camera.controls;
    if (controls) {
      controls.addEventListener("update", () => fragments.core.update());
    }
    const cameraThree = world.camera.three;

    world.onCameraChanged.add((camera) => {
      for (const [, m] of fragments.list) m.useCamera(camera.three);
      fragments.core.update(true);
    });

    fragments.list.onItemSet.add(({ value: model }) => {
      model.useCamera(cameraThree);
      world.scene.three.add(model.object);
      fragments.core.update(true);
    });

    // Coplanar faces z-fight without a polygon offset.
    fragments.core.models.materials.list.onItemSet.add(({ value: material }) => {
      if (!("isLodMaterial" in material && material.isLodMaterial)) {
        material.polygonOffset = true;
        material.polygonOffsetUnits = 1;
        material.polygonOffsetFactor = Math.random();
      }
    });
  }

  private async fetchAndConvert(): Promise<void> {
    const { components, fragments } = this;
    if (!components || !fragments) throw new Error("Fragments not initialised");

    const ifcLoader = components.get(OBC.IfcLoader);
    await ifcLoader.setup({ autoSetWasm: false, wasm: { path: WASM_PATH, absolute: true } });

    this.callbacks.onProgress?.("Fetching model configuration…");
    const configRes = await fetch("/api/config");
    if (!configRes.ok) throw new Error(`Failed to fetch config: HTTP ${configRes.status}`);
    this.config = (await configRes.json()) as ModelConfig;

    this.callbacks.onProgress?.("Fetching IFC…");
    const response = await fetch(`/api/model/${encodeURIComponent(this.config.modelSlug)}`);
    if (!response.ok) throw new Error(`Failed to fetch IFC: HTTP ${response.status}`);

    const bytes = new Uint8Array(await response.arrayBuffer());
    this.callbacks.onProgress?.(
      `IFC received (${(bytes.length / 1e6).toFixed(1)} MB) — converting to Fragments…`,
    );

    // `coordinate: true` (the default, and the second argument here) applies the
    // coordination matrix, moving the model off its georeferenced site origin
    // into a local frame. With `false` the raw coordinates are kept and the
    // building ends up hundreds of units from the origin, which no amount of
    // camera fitting can frame sensibly.
    await ifcLoader.load(bytes, true, this.config.modelSlug, {
      processData: {
        progressCallback: (progress) => {
          this.callbacks.onProgress?.(`Converting to Fragments… ${Math.round((progress ?? 0) * 100)}%`);
        },
      },
    });

    const model = fragments.list.get(this.config.modelSlug);
    if (!model) throw new Error("Model not present in FragmentsManager");
    this.model = model;
  }

  // --------------------------------------------------------------- indexing

  /**
   * Build the storey/room indices.
   *
   * `getItemsOfCategories` is used deliberately: `getSpatialStructure()` stops
   * at the storey level behind a chain of null-category aggregation nodes, so
   * category matching against it finds nothing at all.
   */
  private async indexModel(): Promise<void> {
    const model = this.model;
    if (!model) throw new Error("Model not loaded");

    this.allIds = await model.getItemsIds();

    const byCategory = await model.getItemsOfCategories([
      /^IFCBUILDINGSTOREY$/,
      /^IFCSPACE$/,
    ]);
    const storeyIds: number[] = byCategory.IFCBUILDINGSTOREY ?? [];
    const spaceIds: number[] = byCategory.IFCSPACE ?? [];

    // LongName is the human label; Name is often just an index ("13").
    await this.loadNames(model, storeyIds, this.storeyNames);
    await this.loadNames(model, spaceIds, this.roomNames);

    for (const id of storeyIds) {
      this.storeyElements.set(id, await model.getItemsChildren([id]));
    }
    for (const id of spaceIds) {
      this.roomElements.set(id, await model.getItemsChildren([id]));
    }
    // element -> enclosing room, so a click can name the room.
    for (const [roomId, children] of this.roomElements) {
      for (const child of children) this.elementToRoom.set(child, roomId);
    }

    // Fragments materialises the geometry into the scene graph asynchronously,
    // so measuring the meshes here would find an empty scene. Wait for them.
    await this.waitForGeometry();
    await this.fitCamera();

    // The section plane needs the real bounds to map its 0..1 offset onto world
    // coordinates, so it is set up after the first successful measurement.
    if (this.components && this.world && this.lastBounds) {
      this.sectionPlane = new SectionPlane(this.world.scene.three);
      this.sectionPlane.setBounds(this.lastBounds);
      // Fragments draws with its own tiling renderer, so it needs the plane
      // handed to it directly — material.clippingPlanes alone does nothing.
      this.sectionPlane.attachFragmentsModel(this.model);
    }

    const storeys: Storey[] = storeyIds.map((id) => ({
      localId: id,
      name: this.storeyNames.get(id) ?? `Storey ${id}`,
      elementCount: this.storeyElements.get(id)?.length ?? 0,
    }));
    const rooms: Room[] = spaceIds.map((id) => ({
      localId: id,
      name: this.roomNames.get(id) ?? `#${id}`,
      elementCount: this.roomElements.get(id)?.length ?? 0,
    }));

    this.callbacks.onReady?.({
      elementCount: this.allIds.length,
      storeys,
      rooms,
    });
  }

  private async loadNames(
    model: FragmentsModel,
    ids: number[],
    into: Map<number, string>,
  ): Promise<void> {
    if (!ids.length) return;
    const data = await model.getItemsData(ids, {
      attributesDefault: true,
      relationsDefault: { attributes: false, relations: false },
    });
    for (const item of data) {
      const localId = unwrap(item._localId);
      if (typeof localId !== "number") continue;
      const name = asString(item.LongName) ?? asString(item.Name);
      if (name) into.set(localId, name);
    }
  }

  /**
   * Frame the camera on `localIds` (or the whole model when omitted).
   *
   * The bounds come from the rendered three.js object, not `getBoxes()`: the
   * latter is in raw IFC coordinates while the model is drawn through a
   * coordination matrix, which lands the camera hundreds of units adrift.
   */
  private async fitCamera(localIds?: number[]): Promise<void> {
    const { world, model } = this;
    if (!world || !model) return;

    const bounds = await this.computeBounds(localIds);
    if (bounds.isEmpty()) return;
    this.lastBounds = bounds.clone();

    const center = bounds.getCenter(new THREE.Vector3());
    const size = bounds.getSize(new THREE.Vector3());
    this.lastFramedSize = [size.x, size.y, size.z].map((n) => +n.toFixed(1)) as [
      number,
      number,
      number,
    ];
    // Distance for the vertical FOV, not the bounding-sphere radius: a
    // 280 x 546 x 281 m model has a ~600 unit radius, and `setLookAt` measures
    // distance from the centre of the viewport, which is what camera-controls
    // uses. Framing off the radius puts the whole model in a few pixels.
    const camera = world.camera.three as THREE.PerspectiveCamera;
    const vFov = ((camera.fov ?? 50) * Math.PI) / 180;
    const fitHeight = size.y / 2 / Math.tan(vFov / 2);
    const aspect = camera.aspect || 1;
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * aspect);
    const fitWidth = Math.max(size.x, size.z) / 2 / Math.tan(hFov / 2);
    const distance = Math.max(fitHeight, fitWidth) * 1.35;

    await this.lookFrom(center, new THREE.Vector3(1, 0.75, 1).normalize(), distance);
  }

  /** Shared `setLookAt` so framing and view presets behave identically. */
  private async lookFrom(
    center: THREE.Vector3,
    dir: THREE.Vector3,
    distance: number,
  ): Promise<void> {
    const world = this.world;
    if (!world) return;
    await world.camera.controls.setLookAt(
      center.x + dir.x * distance,
      center.y + dir.y * distance,
      center.z + dir.z * distance,
      center.x,
      center.y,
      center.z,
      true, // immediate: the next frame should already be framed
    );
  }

  /**
   * Snap to a standard view chosen on the view cube, keeping the current
   * distance so the cube does not also zoom.
   */
  private async lookFromFace(face: CubeFace): Promise<void> {
    const world = this.world;
    if (!world) return;
    await this.waitForGeometry();

    const bounds = this.lastBounds && !this.lastBounds.isEmpty()
      ? this.lastBounds
      : await this.computeBounds();
    if (bounds.isEmpty()) return;

    const center = bounds.getCenter(new THREE.Vector3());
    const camera = world.camera.three as THREE.PerspectiveCamera;
    const distance = camera.position.distanceTo(center) || 1;
    // A perfectly vertical direction leaves the camera roll undefined, which is
    // what made the old Top preset come out flipped; nudge Z by a hair.
    const dir = FACE_DIRECTIONS[face].clone();
    if (dir.y !== 0) dir.z += 0.0001;
    await this.lookFrom(center, dir.normalize(), distance);
  }

  /**
   * The box the camera is framed on.
   *
   * Two traps, both of which made a correctly-fitted camera show a speck:
   *  - The whole-model box is dominated by the georeferenced site offset (this
   *    model is MILLI METRE at x=-105235), giving 280 x 546 x 281 "units"
   *    around a 26 x 49 x 47 m house.
   *  - A merged box is dominated by ONE broken element:
   *    `ARC_573_Round transition_angle` (id 214478) spans 47 m alone, doubling
   *    the vertical extent of an 8 m house. A *global* outlier threshold is
   *    equally wrong though — it discarded the upper storeys along with the bad
   *    duct and framed a 9.6 m slab the house did not fit inside. So drop only
   *    elements that are both bigger than the whole storey band AND reach
   *    outside it.
   */
  /**
   * Wait until the scene actually contains meshes.
   *
   * Fragments builds the geometry after the model is handed over, so any
   * measurement taken immediately afterwards sees an empty scene and the
   * camera gets framed on nothing. Poll the render loop rather than guessing a
   * delay.
   */
  private async waitForGeometry(timeoutMs = 10_000): Promise<boolean> {
    const world = this.world;
    if (!world) return false;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      let meshes = 0;
      world.scene.three.traverse((obj) => {
        if ((obj as THREE.Mesh).isMesh) meshes += 1;
      });
      if (meshes > 0) return true;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    console.warn("No meshes appeared in the scene before the timeout");
    return false;
  }

  /**
   * Per-mesh world boxes, with the outliers already dropped.
   *
   * The Fragments box APIs cannot be used for framing on this model:
   * `getBoxes()`, `getMergedBox(storeyIds)` and `getMergedBox(storeyChildren)`
   * all report 280.9 x 546.6 x 281.1, and that number is REAL — reading the
   * three.js meshes directly shows two broken meshes spanning 652 m and 375 m,
   * hundreds of units from the house (45.9 m and 45.6 m near the origin). So the
   * frame is measured from rendered geometry, and "outlier" means a mesh whose
   * own span exceeds 8x the median mesh span.
   */
  private collectRenderedMeshes(): Array<{ box: THREE.Box3; span: number; mesh: THREE.Mesh }> {
    const model = this.model;
    const found: Array<{ box: THREE.Box3; span: number; mesh: THREE.Mesh }> = [];

    const read = (root: THREE.Object3D): void => {
      root.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (!mesh.isMesh || !mesh.geometry) return;
        const geometry = mesh.geometry as THREE.BufferGeometry;
        if (!geometry.boundingBox) {
          try {
            geometry.computeBoundingBox();
          } catch {
            return; // LOD geometry that will not compute; skip it
          }
        }
        const local = geometry.boundingBox;
        if (!local || local.isEmpty()) return;
        mesh.updateWorldMatrix(true, false);
        const world = local.clone().applyMatrix4(mesh.matrixWorld);
        found.push({ box: world, span: world.getSize(new THREE.Vector3()).length(), mesh });
      });
    };

    if (model?.object) {
      model.object.updateWorldMatrix(true, true);
      read(model.object);
    }
    // Fragments populates the scene graph asynchronously, so if the model object
    // yielded nothing, try the whole scene.
    if (!found.length) this.world?.scene.three.traverse(read);
    return found;
  }

  private computeRenderedBounds(): THREE.Box3 {
    const bounds = new THREE.Box3();
    const all = this.collectRenderedMeshes();
    if (!all.length) {
      this.boundsTrace = { path: "rendered-empty" };
      return bounds;
    }

    // Median mesh span: the house is many similar-sized pieces, so the median is
    // a robust scale even when a couple of meshes are nonsense.
    const spans = all.map((m) => m.span).sort((a, b) => a - b);
    const median = spans[Math.floor(spans.length / 2)] || 1;
    const limit = Math.max(median * 8, 1);

    let kept = 0;
    for (const { box, span } of all) {
      if (span > limit) continue;
      bounds.union(box);
      kept += 1;
    }
    this.outlierCount = all.length - kept;
    this.boundsTrace = {
      path: "rendered",
      meshes: all.length,
      median: +median.toFixed(2),
      limit: +limit.toFixed(2),
      kept,
    };
    if (kept > 0) return bounds;
    for (const { box } of all) bounds.union(box);
    return bounds;
  }

  /**
   * The true extent of some items, measured from their own mesh geometry.
   *
   * The Fragments box APIs cannot be used for framing on this model:
   * `getBoxes()`, `getMergedBox(storeyIds)` and `getMergedBox(storeyChildren)`
   * all report 280.9 x 546.6 x 281.1, and that number is REAL — reading the
   * rendered three.js meshes directly shows two broken meshes spanning 652 m and
   * 375 m, hundreds of units from the house (45.9 m and 45.6 m near the origin).
   * The outliers live inside the union, so no amount of filtering the reported
   * boxes helps.
   *
   * `getItemsGeometry(ids)` returns each item's real vertex positions plus its
   * transform, which is the only measurement that is both id-scoped (so a storey
   * can be framed on itself) and complete. Note that `getPositions()` is NOT
   * usable here: on this model it returns 798 vertices for a 13,493-element
   * house, so it frames a 119 m box and draws 3,084 triangles instead of 191,940.
   */
  private async boundsFromGeometry(localIds?: number[]): Promise<THREE.Box3> {
    const model = this.model;
    const bounds = new THREE.Box3();
    if (!model) return bounds;

    let matrix: THREE.Matrix4;
    let groups: MeshData[][];
    try {
      [matrix, groups] = await Promise.all([
        model.getCoordinationMatrix(),
        localIds?.length ? model.getItemsGeometry(localIds) : Promise.resolve([]),
      ]);
    } catch (error) {
      console.warn("getItemsGeometry failed", error);
      return bounds;
    }
    if (!groups.length) return bounds;

    let vertices = 0;
    for (const group of groups) {
      for (const mesh of group) {
        const positions = mesh.positions;
        if (!positions?.length) continue;
        const transform = mesh.transform ?? new THREE.Matrix4();
        for (let i = 0; i + 2 < positions.length; i += 3) {
          bounds.expandByPoint(
            new THREE.Vector3(positions[i], positions[i + 1], positions[i + 2])
              .applyMatrix4(transform)
              .applyMatrix4(matrix),
          );
          vertices += 1;
        }
      }
    }
    if (!vertices) return bounds;
    this.boundsTrace = {
      path: localIds?.length ? "geometry-scoped" : "geometry",
      vertices,
    };
    return bounds;
  }

  private async computeBounds(localIds?: number[]): Promise<THREE.Box3> {
    const model = this.model;
    const bounds = new THREE.Box3();
    if (!model) return bounds;

    this.boundsTrace = { called: true, path: "start" };

    // When a specific set of items was asked for, their own geometry is the
    // only trustworthy measurement: the rendered-mesh path cannot filter by id,
    // and the Fragments boxes are the thing that is broken.
    if (localIds?.length) {
      const scoped = await this.boundsFromGeometry(localIds);
      if (!scoped.isEmpty()) {
        this.outlierCount = 0;
        return scoped;
      }
    }

    // Whole model: measure the rendered geometry, dropping the outlier meshes.
    const rendered = this.computeRenderedBounds();
    if (!rendered.isEmpty()) return rendered;

    // Last resort: the Fragments boxes, which at least return something.
    const [boxes, matrix] = await Promise.all([
      model.getBoxes(),
      model.getCoordinationMatrix(),
    ]);
    for (const box of boxes) {
      if (box) bounds.union(box.clone().applyMatrix4(matrix));
    }
    return bounds;
  }

  // ------------------------------------------------------------- navigation

  /** Frame everything currently visible — the "I lost the model" button. */
  async frameAll(): Promise<{ visible: number; total: number }> {
    await this.waitForGeometry();
    await this.fitCamera();
    const { visible, total } = this.visibility();
    return { visible, total };
  }

  /**
   * Snap to an axis-aligned view over the currently framed bounds.
   * `iso` is the three-quarter default; the rest are true plan/elevation.
   */
  async setView(preset: ViewPreset): Promise<void> {
    const world = this.world;
    if (!world) return;

    await this.waitForGeometry();

    const bounds =
      this.lastBounds && !this.lastBounds.isEmpty()
        ? this.lastBounds.clone()
        : await this.computeBounds();
    if (bounds.isEmpty()) return;
    this.lastBounds = bounds.clone();

    const center = bounds.getCenter(new THREE.Vector3());
    const size = bounds.getSize(new THREE.Vector3());
    const camera = world.camera.three as THREE.PerspectiveCamera;
    const vFov = ((camera.fov ?? 50) * Math.PI) / 180;
    const aspect = camera.aspect || 1;
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * aspect);

    // Each preset carries its own direction and the axis that must fit.
    const { dir, fit } = VIEW_PRESETS[preset];
    const distance =
      Math.max(
        (fit === "y" ? size.y / 2 / Math.tan(vFov / 2) : size.z / 2 / Math.tan(vFov / 2)),
        fit === "x" ? size.x / 2 / Math.tan(hFov / 2) : 0,
      ) * 1.35;

    await this.lookFrom(center, dir, Math.max(distance, 1));
  }

  // --------------------------------------------------------------- picking

  private initPicking(): void {
    const { components, world, fragments } = this;
    if (!components || !world || !fragments) return;

    components.get(OBC.Raycasters).get(world);
    const highlighter = components.get(OBF.Highlighter);
    highlighter.setup({
      world,
      selectMaterialDefinition: {
        // Selection colour. NOT `oklch(...)` — three.js cannot parse that
        // colour model and silently logs "Unknown color model", leaving the
        // highlight unset. Convert the theme's --brand-teal
        // oklch(0.65 0.12 180) to a hex literal instead.
        color: new THREE.Color("#4fd6c0"),
        opacity: 1,
        transparent: false,
        renderedFaces: 0,
      },
    });

    highlighter.events.select.onHighlight.add((modelIdMap) => {
      void this.reportSelection(modelIdMap);
    });
    highlighter.events.select.onClear.add(() => {
      this.lastSelection = null;
      this.callbacks.onSelection?.(null);
    });
  }

  private async reportSelection(modelIdMap: Record<string, Set<number>>): Promise<void> {
    const fragments = this.fragments;
    if (!fragments) return;

    try {
      const batches: Array<Promise<ItemData[]>> = [];
      let target: FragmentsModel | null = null;
      for (const [modelId, localIds] of Object.entries(modelIdMap)) {
        const model = fragments.list.get(modelId);
        if (!model) continue;
        target = target ?? model;
        batches.push(
          model.getItemsData([...localIds], {
            attributesDefault: true,
            // Property sets, quantities and material layers are NOT in the
            // default payload: they arrive through relation traversal, and the
            // traversal is also what brings a set's `HasProperties` along.
            // `IsTypedBy` is listed for other models' benefit — this one links
            // the type object through `IsDefinedBy` instead, and an unknown
            // relation tag is harmless.
            relations: {
              IsDefinedBy: { attributes: true, relations: true },
              IsTypedBy: { attributes: true, relations: true },
              HasAssociations: { attributes: true, relations: true },
            },
            relationsDefault: { attributes: false, relations: false },
          }),
        );
      }
      const data = (await Promise.all(batches)).flat();
      const item = data[0];
      if (!item || !target) return;

      const localId = unwrap(item._localId);
      const roomId = typeof localId === "number" ? this.elementToRoom.get(localId) : undefined;

      const { sets, typeName } = await collectPropertySets(target, item);
      const { layers, setName } = collectMaterialLayers(item);

      const selection: Selection = {
        localId: typeof localId === "number" ? localId : -1,
        category: asString(item._category) ?? "",
        name: asString(item.Name),
        guid: asString(item._guid),
        room: roomId == null ? null : (this.roomNames.get(roomId) ?? `#${roomId}`),
        circuit: findCircuitPset(sets),
        propertySets: sets,
        materialLayers: layers,
        materialLayerSetName: setName,
        typeName,
        attributes: collectAttributes(item),
      };
      this.lastSelection = selection;
      this.callbacks.onSelection?.(selection);
    } catch (err) {
      this.callbacks.onError?.(err instanceof Error ? err.message : String(err));
    }
  }

  // ---------------------------------------------------------------- public

  /** Show only one storey. `null` restores the whole model. */
  async setStorey(localId: number | null): Promise<{ visible: number; total: number }> {
    const model = this.model;
    if (!model) return { visible: 0, total: 0 };

    await model.setVisible(undefined, true);
    this.activeStorey = localId;
    if (localId === null) {
      await this.fitCamera();
      return { visible: this.allIds.length, total: this.allIds.length };
    }

    const children = new Set(this.storeyElements.get(localId) ?? []);
    const hidden = this.allIds.filter((id) => !children.has(id));
    await model.setVisible(hidden, false);
    // Deliberately NO camera move.
    //
    // Re-framing on the storey was wrong, and it cannot be fixed from outside
    // the library. Fragments hides an element by OMITTING it from the draw
    // call, not by setting three.js visibility: measured with a storey
    // isolated, `model.visibleItems` still reports 256 ids and all 121 meshes
    // still have `visible === true`, while the triangle count correctly drops
    // (200,220 -> 157,309). So there is no "visible mesh" subset in the scene
    // graph to measure and aim at.
    //
    // Every route that does return a box is wrong on this model:
    // - getBoxes()/getMergedBox(): element 144267, a 0.8 m kitchen hob, makes
    //   web-ifc emit 225.3 x 546.6 x 221.3 m of geometry (IfcOpenShell does not
    //   reproduce it, so it is a web-ifc bug, not bad model data);
    // - getItemsGeometry(ids): its per-mesh `transform` has a nonsense diagonal
    //   ([-0.749, 0, 0]) and puts the storey 217 m from where it renders
    //   (centre x=+108.5 vs the true x=-110);
    // - getPositions(): 798 vertices for 13,493 elements.
    //
    // A camera pointed at empty space is worse than one left alone, so the
    // filter now only filters. Use the SECTION to aim at a floor: it works, and
    // it is the control that can express "above" and "below" as well.
    await this.fragments?.core.update(true);
    return { visible: children.size, total: this.allIds.length };
  }

  /**
   * Move or toggle the section plane.
   *
   * `side` is the above/below control: the plane stays where it is and only the
   * normal flips, so the same slider shows the storey above the cut or the one
   * below it. Storey isolation cannot express that (it can only show one whole
   * storey), which is why this is a separate control.
   */
  setSection(state: SectionState): void {
    const section = this.sectionPlane;
    if (!section) return;
    section.setBounds(this.lastBounds);
    section.apply(state, this.world?.renderer?.three as THREE.WebGLRenderer | undefined);
    // Ask the fragments renderer for a fresh frame, otherwise the new plane is
    // only picked up on the next camera move.
    void this.fragments?.core.update(true);
  }

  /** What is visible right now, given the active storey filter. */
  private visibility(): { visible: number; total: number } {
    return this.activeStorey === null
      ? { visible: this.allIds.length, total: this.allIds.length }
      : {
          visible: this.storeyElements.get(this.activeStorey)?.length ?? 0,
          total: this.allIds.length,
        };
  }

  /** Make everything visible again and drop the storey filter. */
  async showAll(): Promise<{ visible: number; total: number }> {
    await this.setStorey(null);
    this.activeStorey = null;
    return { visible: this.allIds.length, total: this.allIds.length };
  }

  /** Current visible/total counts, for the status line. */
  get visibleCount(): number {
    return this.visibility().visible;
  }

  get totalCount(): number {
    return this.allIds.length;
  }

  get circuitFieldLabels(): ReadonlyArray<readonly [string, string]> {
    return CIRCUIT_LABELS;
  }

  /** The Fragments model, for the headless diagnostics only. */
  get modelForDiag(): FragmentsModel | null {
    return this.model;
  }

  /** Storey -> its element ids, for the headless diagnostics only. */
  get storeyElementsForDiag(): Record<number, number[]> {
    return Object.fromEntries(this.storeyElements);
  }

  /** Display title for the model, from the backend config. */
  get modelTitle(): string {
    return this.config?.modelTitle ?? "BIM model";
  }

  /** Diagnostic surface for the headless verification run. */
  debugCamera(): Record<string, unknown> | null {
    const { world, model } = this;
    if (!world || !model?.object) return null;
    const round = (v: THREE.Vector3): [number, number, number] =>
      [v.x, v.y, v.z].map((n) => +n.toFixed(1)) as [number, number, number];
    const position = world.camera.three.position;

    // Is the model actually IN the scene, and is anything drawn? A correct
    // camera on an empty scene still renders nothing.
    let meshes = 0;
    let visible = 0;
    model.object.traverse((obj) => {
      const asMesh = obj as THREE.Mesh;
      if (asMesh.isMesh) {
        meshes += 1;
        if (asMesh.visible) visible += 1;
      }
    });
    const inScene = world.scene.three.children.includes(model.object);

    return {
      cameraPosition: round(position),
      distance: +position.length().toFixed(1),
      fov: (world.camera.three as THREE.PerspectiveCamera).fov,
      wholeModelSize: round(new THREE.Box3().setFromObject(model.object).getSize(new THREE.Vector3())),
      storeyBoxes: Object.fromEntries(
        [...this.storeyElements.entries()].map(([id, kids]) => [
          this.storeyNames.get(id) ?? id,
          kids.length,
        ]),
      ),
      lastFramedSize: this.lastFramedSize,
      outliersRejected: this.outlierCount,
      modelInScene: inScene,
      meshCount: meshes,
      visibleMeshCount: visible,
      sceneChildren: world.scene.three.children.length,
      // Decisive: is the frame box big enough to hold the storey band? And did
      // the outlier filter actually drop the 47 m duct? Both are the numbers
      // that decide whether the house is in frame.
      renderInfo: world.renderer?.three
        ? { ...(world.renderer.three.info.render as unknown as Record<string, number>) }
        : null,
      framedBounds: this.lastBounds
        ? {
            min: round(this.lastBounds.min),
            max: round(this.lastBounds.max),
            size: round(this.lastBounds.getSize(new THREE.Vector3())),
          }
        : null,
      storeyBox: this.storeyBoxForDiag
        ? { min: round(this.storeyBoxForDiag.min), max: round(this.storeyBoxForDiag.max) }
        : null,
      boundsTrace: this.boundsTrace,
      viewCubeMounted: this.viewCube !== null,
      sectionReady: this.sectionPlane !== null,
      sectionApplied: this.sectionPlane?.isApplied ?? false,
      // Selection probe for the headless attribute-panel check: which
      // element is selected and which sets the inspector can render.
      selection: this.lastSelection
        ? {
            localId: this.lastSelection.localId,
            guid: this.lastSelection.guid,
            category: this.lastSelection.category,
            propertySets: this.lastSelection.propertySets.map((s) => ({
              name: s.name,
              kind: s.kind,
              properties: Object.keys(s.properties).length,
            })),
            materialLayers: this.lastSelection.materialLayers.length,
            materialLayerSetName: this.lastSelection.materialLayerSetName,
            typeName: this.lastSelection.typeName,
          }
        : null,
      sectionPlane: this.sectionPlane
        ? {
            normal: [
              +this.sectionPlane.plane.normal.x.toFixed(2),
              +this.sectionPlane.plane.normal.y.toFixed(2),
              +this.sectionPlane.plane.normal.z.toFixed(2),
            ],
            constant: +this.sectionPlane.plane.constant.toFixed(2),
          }
        : null,
      clippedMaterials: (() => {
        let count = 0;
        world.scene.three.traverse((obj) => {
          const mesh = obj as THREE.Mesh;
          const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
          if (!material || !mesh.isMesh) return;
          for (const entry of Array.isArray(material) ? material : [material]) {
            if (entry?.clippingPlanes?.length) count += 1;
          }
        });
        return count;
      })(),
    };
  }

  dispose(): void {
    this.components?.dispose?.();
    this.components = null;
    this.fragments = null;
    this.model = null;
    this.world = null;
  }
}
