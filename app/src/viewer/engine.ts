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
import type { FragmentsModel } from "@thatopen/fragments";
import * as THREE from "three";

import {
  type CircuitPset,
  type ItemData,
  type Room,
  type Selection,
  type Storey,
  unwrap,
} from "./types";

const MODEL_URL = "/api/model/Achterhekers57.ifc";
const MODEL_ID = "achterhekers57";
const WASM_PATH = "/wasm/";

/** The concrete world shape this engine builds. */
type ViewerWorld = OBC.SimpleWorld<OBC.SimpleScene, OBC.SimpleCamera, OBC.SimpleRenderer>;

/** Property names exactly as they appear on Pset_ElectricalCircuit in this model. */
const CIRCUIT_FIELDS: ReadonlyArray<readonly [string, string]> = [
  ["Board", "Board"],
  ["Circuit", "Circuit"],
  ["CircuitLoads", "Loads"],
  ["MainRating", "Hoofdvermogen"],
  ["Rating", "Rating"],
  ["Cable", "Kabel"],
  ["RCD", "RCD"],
  ["SourceSheet", "Bron"],
  ["MatchMethod", "Match"],
];

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

/**
 * Find `Pset_ElectricalCircuit` anywhere in an item payload.
 *
 * Property sets arrive nested under IsDefinedBy -> IfcRelDefinesByProperties,
 * not as a flat record, so this walks the object graph.
 */
function findCircuitPset(root: unknown): CircuitPset | null {
  if (!root || typeof root !== "object") return null;
  if (Array.isArray(root)) {
    for (const child of root) {
      const hit = findCircuitPset(child);
      if (hit) return hit;
    }
    return null;
  }
  const node = root as Record<string, unknown>;
  if (node.Name === "Pset_ElectricalCircuit" && Array.isArray(node.HasProperties)) {
    const out: CircuitPset = {};
    for (const entry of node.HasProperties as Array<Record<string, unknown>>) {
      const key = asString(entry?.Name);
      if (!key) continue;
      const value = asString(entry.NominalValue ?? entry.UnitBasedValue);
      if (value !== null) out[key] = value;
    }
    return out;
  }
  for (const value of Object.values(node)) {
    const hit = findCircuitPset(value);
    if (hit) return hit;
  }
  return null;
}

export class ViewerEngine {
  private components: OBC.Components | null = null;
  private fragments: OBC.FragmentsManager | null = null;
  private model: FragmentsModel | null = null;
  private world: ViewerWorld | null = null;

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
  }

  private async initFragments(): Promise<void> {
    const { components, world } = this;
    if (!components || !world) throw new Error("world not initialised");

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
    if (!components || !fragments) throw new Error("fragments not initialised");

    const ifcLoader = components.get(OBC.IfcLoader);
    await ifcLoader.setup({ autoSetWasm: false, wasm: { path: WASM_PATH, absolute: true } });

    this.callbacks.onProgress?.("IFC ophalen…");
    const response = await fetch(MODEL_URL);
    if (!response.ok) throw new Error(`IFC ophalen mislukt: HTTP ${response.status}`);

    const bytes = new Uint8Array(await response.arrayBuffer());
    this.callbacks.onProgress?.(
      `IFC binnen (${(bytes.length / 1e6).toFixed(1)} MB) — naar Fragments…`,
    );

    // `coordinate: true` (the default, and the second argument here) applies the
    // coordination matrix, moving the model off its georeferenced site origin
    // (x=-105235, y=-43940) into a local frame. With `false` the raw
    // coordinates are kept and the building ends up ~690 units from the origin,
    // which no amount of camera fitting can frame sensibly.
    await ifcLoader.load(bytes, true, MODEL_ID, {
      processData: {
        progressCallback: (progress) => {
          this.callbacks.onProgress?.(`Naar Fragments… ${Math.round((progress ?? 0) * 100)}%`);
        },
      },
    });

    const model = fragments.list.get(MODEL_ID);
    if (!model) throw new Error("model not present in FragmentsManager");
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
    if (!model) throw new Error("model not loaded");

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

    await this.fitCamera();

    const storeys: Storey[] = storeyIds.map((id) => ({
      localId: id,
      name: this.storeyNames.get(id) ?? `Verdieping ${id}`,
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

    let bounds = new THREE.Box3();

    // Prefer the merged box of just the elements in question, so a storey
    // filter actually reframes.
    if (localIds?.length) {
      const [boxes, matrix] = await Promise.all([
        model.getMergedBox(localIds),
        model.getCoordinationMatrix(),
      ]);
      if (boxes && !boxes.isEmpty()) bounds.union(boxes.clone().applyMatrix4(matrix));
    }

    if (bounds.isEmpty() && model.object) {
      model.object.updateWorldMatrix(true, true);
      bounds.setFromObject(model.object);
    }
    if (bounds.isEmpty()) {
      const [boxes, matrix] = await Promise.all([
        model.getBoxes(),
        model.getCoordinationMatrix(),
      ]);
      for (const box of boxes) {
        if (box) bounds.union(box.clone().applyMatrix4(matrix));
      }
    }
    // Frame on the STOREYS, not on everything: the site prims and the
    // georeferenced offset (this model is MILLI METRE at x=-105235) inflate the
    // whole-model box to 280 x 546 x 281 "units" around a 26 x 49 x 47 m house.
    //
    // A single bad element also stretches it: `ARC_573_Round transition_angle`
    // (id 214478) spans 47 m on its own, and it is what pushes the vertical
    // extent past the building's real 8 m. So the framing box is computed from
    // per-element boxes with outliers dropped, rather than from a merged box
    // that a single bad element dominates.
    const matrix = await model.getCoordinationMatrix();
    const boxes = await model.getBoxes();
    if (boxes.length) {
      const centers = boxes
        .filter(Boolean)
        .map((box) => box.getCenter(new THREE.Vector3()));
      const median = centers
        .map((c) => c.length())
        .sort((a, b) => a - b)[Math.floor(centers.length / 2)];

      const robust = new THREE.Box3();
      let kept = 0;
      for (const box of boxes) {
        if (!box) continue;
        const span = box.getSize(new THREE.Vector3()).length();
        // Anything reaching a third of the way to the far side of the model
        // from the median centre is an outlier, not a storey.
        if (span > median * 0.3) continue;
        robust.union(box.clone().applyMatrix4(matrix));
        kept += 1;
      }
      if (kept > 0 && !robust.isEmpty()) bounds = robust;
      this.lastFramedSize = [
        bounds.max.x - bounds.min.x,
        bounds.max.y - bounds.min.y,
        bounds.max.z - bounds.min.z,
      ].map((n) => +n.toFixed(1)) as [number, number, number];
      this.outlierCount = boxes.length - kept;
    }

    if (bounds.isEmpty()) return;

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

    // Aim from a three-quarter angle so storeys read as separate volumes
    // rather than a plan view.
    const dir = new THREE.Vector3(1, 0.75, 1).normalize();
    await world.camera.controls.setLookAt(
      center.x + dir.x * distance,
      center.y + dir.y * distance,
      center.z + dir.z * distance,
      center.x,
      center.y,
      center.z,
      true, // immediate: the first frame should already be framed
    );
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
        // Brand teal, matching the shadcn theme (--brand-teal).
        color: new THREE.Color("oklch(0.65 0.12 180)"),
        opacity: 1,
        transparent: false,
        renderedFaces: 0,
      },
    });

    highlighter.events.select.onHighlight.add((modelIdMap) => {
      void this.reportSelection(modelIdMap);
    });
    highlighter.events.select.onClear.add(() => {
      this.callbacks.onSelection?.(null);
    });
  }

  private async reportSelection(modelIdMap: Record<string, Set<number>>): Promise<void> {
    const fragments = this.fragments;
    if (!fragments) return;

    try {
      const batches: Array<Promise<ItemData[]>> = [];
      for (const [modelId, localIds] of Object.entries(modelIdMap)) {
        const model = fragments.list.get(modelId);
        if (!model) continue;
        batches.push(
          model.getItemsData([...localIds], {
            attributesDefault: true,
            // Property sets are not in the default payload; ask for them.
            relations: { IsDefinedBy: { attributes: true, relations: true } },
            relationsDefault: { attributes: false, relations: false },
          }),
        );
      }
      const data = (await Promise.all(batches)).flat();
      const item = data[0];
      if (!item) return;

      const localId = unwrap(item._localId);
      const roomId = typeof localId === "number" ? this.elementToRoom.get(localId) : undefined;

      this.callbacks.onSelection?.({
        localId: typeof localId === "number" ? localId : -1,
        category: asString(item._category) ?? "",
        name: asString(item.Name),
        guid: asString(item._guid),
        room: roomId == null ? null : (this.roomNames.get(roomId) ?? `#${roomId}`),
        circuit: findCircuitPset(item),
      });
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
    if (localId === null) {
      await this.fitCamera();
      return { visible: this.allIds.length, total: this.allIds.length };
    }

    const children = new Set(this.storeyElements.get(localId) ?? []);
    const hidden = this.allIds.filter((id) => !children.has(id));
    await model.setVisible(hidden, false);
    // Re-frame on the storey: isolating a floor is pointless if the camera
    // stays where the whole model was framed from.
    await this.fitCamera(children.size ? [...children] : undefined);
    return { visible: children.size, total: this.allIds.length };
  }

  get circuitFieldLabels(): ReadonlyArray<readonly [string, string]> {
    return CIRCUIT_FIELDS;
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
      // Decisive: triangles actually submitted last frame. A non-zero count
      // proves the scene IS being drawn, which separates "the app renders
      // nothing" from "headless screenshot compositing misses the canvas".
      renderInfo: world.renderer?.three
        ? { ...(world.renderer.three.info.render as unknown as Record<string, number>) }
        : null,
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
