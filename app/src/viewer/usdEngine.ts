/**
 * The USD engine.
 *
 * Mirrors the shape of the IFC engine deliberately — same callbacks, same
 * imperative lifetime, same "React owns the UI, this owns the scene" split — so
 * the panels, the view cube and the section plane are shared rather than
 * reimplemented.
 *
 * WHY THE SCENE IS FLATTENED SERVER-SIDE
 * --------------------------------------
 * three.js `USDLoader` cannot open a layer stack. For a standalone file it calls
 * `composer.compose(data, {}, {}, path)` with an EMPTY assets dict, so
 * `_resolveReference` can only ever return null, and nothing in the package
 * parses `subLayers` at all. The house stack is 5 subLayers deep plus a
 * reference, so it renders nothing. `cad/build_web_usd.py` flattens the stack
 * into one self-contained ASCII layer, which is what this loads.
 *
 * WHY ASCII AND NOT .usdc
 * -----------------------
 * `USDCParser._readInlinedValue` handles Vec2f/Vec3f/Vec4f but not the `double`
 * variants, so an inlined `double3` falls to `default: return payload` and
 * decodes as a RAW UINT32. On this model 142 of 1378 `xformOp:translate`
 * attributes came back as bare scalars where pxr reads `(2, 0, 0)`, and
 * `applyTransform` then throws on `makeTranslation(undefined, ...)`. The ASCII
 * parser is unaffected. If a .usdc ever becomes necessary, that parser is the
 * file to fix — not this module.
 *
 * WHY THE PRIM PATH IS THE IDENTITY
 * ---------------------------------
 * There is no IFC GlobalId anywhere in the USD: a traverse of every prim
 * attribute for `guid`/`ifc`/`globalid` finds nothing. Prim names embed *Revit*
 * ids and the IFC category is a path SEGMENT. So the composed three.js
 * hierarchy is walked once and the full USD prim path is stored in `userData` —
 * that path is the only stable handle the format gives us, and the IFC tab stays
 * the source of identity.
 */
import { USDLoader } from "three/examples/jsm/loaders/USDLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import * as THREE from "three";

import { FACE_DIRECTIONS, ViewCube, type CubeFace } from "./viewCube";
import { SectionPlane, type SectionState } from "./sectionPlane";
import { VIEW_PRESETS, type ViewPreset } from "./viewPresets";
import type { UsdLayer, UsdManifest, UsdPrimInfo, UsdIfcPathInfo } from "./usdTypes";

export type { ViewPreset };

export interface UsdEngineCallbacks {
  onProgress?: (detail: string) => void;
  onReady?: (info: {
    meshCount: number;
    primCount: number;
    layers: UsdLayer[];
  }) => void;
  onSelection?: (prim: UsdPrimInfo | null) => void;
  onError?: (message: string) => void;
}

/** IFC-derived prim paths carry the storey and category as path segments. */
const HOUSE_ROOT = "House";
const STOREY_SEGMENT = 5;
const CATEGORY_SEGMENT = 6;

/**
 * What this engine attaches to every mesh it indexes. Kept in one type so the
 * write in `indexPrims` and the reads in picking/filters cannot drift.
 */
interface UsdUserData {
  usdPath?: string;
  rootPrim?: string;
  ifc?: UsdIfcPathInfo;
}

const userDataOf = (object: THREE.Object3D): UsdUserData =>
  object.userData as UsdUserData;

/**
 * Use the lights the scene was AUTHORED with instead of the neutral rig.
 *
 * Off by default, and the reason is worth keeping: this scene carries 6
 * `UsdLuxRectLight` + a `DomeLight` from its Blender origin, and the composer
 * instantiates them at intensities 17.5 and 286.5. Those numbers are fine for
 * an offline render with a proper exposure, and ruinous in a viewer whose job
 * is to make geometry legible. The authored rig is therefore suppressed by
 * default and kept in the scene (not deleted) so it can be brought back.
 */
const USE_AUTHORED_LIGHTS = false;

export class UsdEngine {
  private scene: THREE.Scene | null = null;
  private camera: THREE.PerspectiveCamera | null = null;
  private renderer: THREE.WebGLRenderer | null = null;
  private controls: import("three/addons/controls/OrbitControls.js").OrbitControls | null = null;
  private viewCube: ViewCube | null = null;
  private sectionPlane: SectionPlane | null = null;

  /** Every mesh, with its prim path resolved once at load. */
  private meshes: THREE.Mesh[] = [];
  /** prim path -> mesh, so a pick resolves to its attributes in O(1). */
  private byPath = new Map<string, THREE.Mesh>();
  private rootGroup: THREE.Group | null = null;
  /**
   * Lights the scene was authored with, suppressed by default. Kept (not
   * removed) so their values stay inspectable and a toggle could restore them.
   */
  private authoredLights: THREE.Light[] = [];
  private manifest: UsdManifest | null = null;
  private bounds: THREE.Box3 | null = null;
  /** Unfiltered union, diagnostics only. */
  private rawBounds: THREE.Box3 | null = null;
  /** The span above which a mesh is treated as a broken outlier, diagnostics. */
  private outlierLimit: number | null = null;
  private lastSelection: UsdPrimInfo | null = null;
  private activeLayers = new Set<string>();
  private activeStorey: string | null = null;
  private frameHandle = 0;

  private readonly callbacks: UsdEngineCallbacks;

  constructor(callbacks: UsdEngineCallbacks = {}) {
    this.callbacks = callbacks;
  }

  async load(container: HTMLElement): Promise<void> {
    try {
      this.initScene(container);

      this.callbacks.onProgress?.("Reading the scene index…");
      const manifestRes = await fetch("/api/usd/manifest");
      if (!manifestRes.ok) {
        throw new Error(`No USD scene index (HTTP ${manifestRes.status}) — build it with cad/build_web_usd.py`);
      }
      this.manifest = (await manifestRes.json()) as UsdManifest;

      await this.fetchAndCompose();
      this.initPicking();
      this.indexPrims();
      container.style.visibility = "visible";
    } catch (err) {
      this.callbacks.onError?.(err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  // ---------------------------------------------------------------- scene

  private initScene(container: HTMLElement): void {
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0b111d);
    this.scene = scene;

    const width = container.clientWidth || 1;
    const height = container.clientHeight || 1;
    const camera = new THREE.PerspectiveCamera(50, width / height, 0.1, 5000);
    camera.position.set(24, 18, 24);
    this.camera = camera;

    const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(width, height);
    container.append(renderer.domElement);
    this.renderer = renderer;

    // Plain three.js materials, so the shared SectionPlane works unchanged:
    // `material.clippingPlanes` is exactly the mechanism it drives.
    renderer.localClippingEnabled = true;

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.1;
    this.controls = controls;

    // LIGHTING — the white blowout had TWO causes, and the second was the
    // bigger one.
    //
    // (1) This scene was authored with its OWN lights: 6 `UsdLuxRectLight` plus a
    //     `DomeLight` (confirmed with pxr). The USD composer instantiates them
    //     as three.js lights, and their intensities arrive as 17.5 and 286.5 —
    //     the 286 one alone dwarfs everything else in the scene. So the viewport
    //     was carrying a lighting rig I never added, at values that saturate
    //     every surface facing them.
    //
    // (2) On top of that, ambient 1.6 + two directionals with NO tone mapping.
    //
    // The decision: the authored rig is for RENDERING (a Blender-lit interior
    // look), not for a viewer that needs to read geometry. So it is switched off
    // by default and replaced with a neutral three-point rig. It stays in the
    // scene — a toggle could bring it back — because deleting prims the model
    // author put there is not this viewer's call.
    //
    // Set USE_AUTHORED_LIGHTS = true to see the scene as it renders instead.
    // A neutral rig for reading geometry: a hemisphere for ambient shape, a key
    // for form, a weak fill so the shadow side is not black.
    scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x3a3f46, 1.0));
    const key = new THREE.DirectionalLight(0xffffff, 1.5);
    key.position.set(1, 2, 1.4);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xdfe4ea, 0.35);
    fill.position.set(-1.2, 0.6, -0.8);
    scene.add(fill);

    // Without this the sum clips to white. Exposure stays 1.0 so the tone curve,
    // not the intensity, does the work.
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;

    const cube = new ViewCube({
      size: 128,
      onSelect: (face) => {
        void this.lookFromFace(face);
      },
    });
    this.viewCube = cube;
    container.append(cube.element);
    controls.addEventListener("change", () => {
      cube.updateOrientation(camera);
    });

    const loop = (): void => {
      this.frameHandle = requestAnimationFrame(loop);
      controls.update();
      renderer.render(scene, camera);
    };
    loop();

    const onResize = (): void => {
      if (!container.isConnected) return;
      const w = container.clientWidth || 1;
      const h = container.clientHeight || 1;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    };
    window.addEventListener("resize", onResize);
  }

  // ---------------------------------------------------------------- load

  private async fetchAndCompose(): Promise<void> {
    const scene = this.scene;
    if (!scene) throw new Error("Scene not initialised");

    this.callbacks.onProgress?.("Fetching the flattened USD layer…");
    const res = await fetch("/api/usd/scene");
    if (!res.ok) {
      throw new Error(`Failed to fetch the USD scene: HTTP ${res.status}`);
    }
    const text = await res.text();

    this.callbacks.onProgress?.(
      `USD received (${(text.length / 1e6).toFixed(1)} MB) — composing meshes…`,
    );
    const loader = new USDLoader();
    // The composer is synchronous and heavy (~15 s of parse for a 32 MB ASCII
    // layer), so yield to the browser first or the status line never paints.
    await new Promise((resolve) => setTimeout(resolve, 16));
    const group = loader.parse(text, "/", undefined, undefined) as THREE.Group;
    if (!group) throw new Error("The USD layer composed to nothing");

    this.rootGroup = group;
    scene.add(group);
    this.measureBounds();
    this.fitCamera();

    // Suppress the authored lighting rig NOW that the group exists (see
    // USE_AUTHORED_LIGHTS). `visible = false` keeps the prim and its values; it
    // only removes the light from the render list.
    const authored: THREE.Light[] = [];
    group.traverse((obj) => {
      const light = obj as THREE.Light;
      if (light.isLight) authored.push(light);
    });
    for (const light of authored) {
      if (USE_AUTHORED_LIGHTS) {
        light.visible = true;
      } else {
        light.visible = false;
      }
      this.authoredLights.push(light);
    }
    if (authored.length) {
      console.info(
        `[usd] suppressed ${authored.length} authored light(s); using the neutral rig instead`,
      );
    }

    // The shared SectionPlane needs the real bounds to map its 0..1 offset onto
    // world coordinates, so it is built after the first successful measurement.
    this.sectionPlane = new SectionPlane(scene);
    this.sectionPlane.setBounds(this.bounds);
  }

  /**
   * Walk the composed hierarchy once and record each mesh's full USD prim path.
   *
   * The composer names every object from the last path segment, so the prim path
   * is the join of ancestor names. Doing it once here is what makes a click cheap
   * and what gives the panel a quotable identifier.
   */
  private indexPrims(): void {
    const group = this.rootGroup;
    if (!group) return;

    const walk = (object: THREE.Object3D, prefix: string): void => {
      for (const child of object.children) {
        const path = object === group ? `/${child.name}` : `${prefix}/${child.name}`;
        const mesh = child as THREE.Mesh;
        if (mesh.isMesh) {
          const usd = userDataOf(child);
          usd.usdPath = path;
          usd.rootPrim = path.split("/")[1] ?? "";
          usd.ifc = describeIfcPath(path);
          this.meshes.push(mesh);
          this.byPath.set(path, mesh);
        }
        walk(child, path);
      }
    };
    walk(group, "");

    this.measureBounds();
    // Every layer starts visible, so the toggle state is not empty on arrival.
    for (const layer of this.manifest?.layers ?? []) this.activeLayers.add(layer.id);

    this.callbacks.onReady?.({
      meshCount: this.meshes.length,
      primCount: this.meshes.length,
      layers: this.manifest?.layers ?? [],
    });
  }

  /**
   * Bounds from the rendered meshes, dropping per-mesh outliers.
   *
   * NOT `new Box3().setFromObject(root)`: that is a union, so one broken mesh
   * stretches it. This is the same median-span filter the IFC viewer learned.
   *
   * `updateWorldMatrix(true, true)` — the SECOND argument must be `true`.
   * With `(true, false)` only the mesh's own matrix is recomputed and its
   * ancestors' are left stale, so the USD composer's root rotation (it applies
   * `rotation.x = -PI/2` because the stage is Z-up) is missing from every world
   * matrix. The symptom is bounds that are merely *plausible*: the height came
   * out right at 9.5 m but the footprint measured 26.7 x 21.8 m instead of the
   * manifest's 28.1 x 28.3 m.
   */
  private measureBounds(): void {
    if (!this.meshes.length) return;
    this.rootGroup?.updateWorldMatrix(true, true);
    const spans: number[] = [];
    const boxes: THREE.Box3[] = [];
    const size = new THREE.Vector3();
    for (const mesh of this.meshes) {
      if (!mesh.geometry) continue;
      if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
      const local = mesh.geometry.boundingBox;
      if (!local || local.isEmpty()) continue;
      mesh.updateWorldMatrix(true, false);
      const world = local.clone().applyMatrix4(mesh.matrixWorld);
      boxes.push(world);
      spans.push(world.getSize(size).length());
    }
    if (!boxes.length) return;
    // Outlier rejection, measured against the MODEL, not against the median
    // mesh.
    //
    // The IFC viewer uses `8x the median mesh span`, which is right there and
    // wrong here: that model's median is ~0.6 m, so the limit lands at 5.03 m
    // and it discards legitimate walls and slabs, framing 26.7 x 9.5 x 21.8 m
    // instead of the true 28.1 x 9.5 x 28.3 m. This USD is verified clean (the
    // build step reports zero meshes over 25 m), so a limit derived from the
    // house's own extent does the intended job — it still drops a genuinely
    // broken mesh like the 652 m one the IFC model contains, and keeps every
    // real one.
    const rawUnion = new THREE.Box3();
    for (const box of boxes) rawUnion.union(box);
    const modelSpan = rawUnion.getSize(size).length();
    spans.sort((a, b) => a - b);
    const median = spans[Math.floor(spans.length / 2)] || 1;
    const limit = Math.max(median * 8, modelSpan * 0.5, 1);
    this.outlierLimit = +limit.toFixed(2);
    const bounds = new THREE.Box3();
    for (const box of boxes) {
      if (box.getSize(size).length() > limit) continue;
      bounds.union(box);
    }
    this.bounds = bounds;

    // The raw union, reported for diagnostics only. The filtered bounds are what
    // the camera frames; this says whether a size difference is the filter doing
    // its job or a transform that never got applied.
    this.rawBounds = rawUnion;
  }

  /** Frame the camera, fitting the VERTICAL fov and the horizontal one. */
  private fitCamera(localIds?: string[]): void {
    const camera = this.camera;
    if (!camera || !this.bounds || this.bounds.isEmpty()) return;
    const target = localIds?.length ? this.boundsOf(localIds) : this.bounds;
    if (!target || target.isEmpty()) return;

    const center = target.getCenter(new THREE.Vector3());
    const size = target.getSize(new THREE.Vector3());
    const vFov = (camera.fov * Math.PI) / 180;
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * (camera.aspect || 1));
    const distance =
      Math.max(size.y / 2 / Math.tan(vFov / 2), Math.max(size.x, size.z) / 2 / Math.tan(hFov / 2)) * 1.35;
    this.lookFrom(center, new THREE.Vector3(1, 0.75, 1).normalize(), distance);
  }

  private boundsOf(paths: string[]): THREE.Box3 | null {
    const wanted = new Set(paths);
    const bounds = new THREE.Box3();
    let any = false;
    for (const mesh of this.meshes) {
      const usd = userDataOf(mesh);
      if (!usd.usdPath || !wanted.has(usd.usdPath)) continue;
      if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
      const local = mesh.geometry.boundingBox;
      if (!local || local.isEmpty()) continue;
      mesh.updateWorldMatrix(true, false);
      bounds.union(local.clone().applyMatrix4(mesh.matrixWorld));
      any = true;
    }
    return any ? bounds : null;
  }

  private lookFrom(center: THREE.Vector3, dir: THREE.Vector3, distance: number): void {
    const camera = this.camera;
    const controls = this.controls;
    if (!camera || !controls) return;
    camera.position.copy(center).addScaledVector(dir, distance);
    controls.target.copy(center);
    controls.update();
  }

  // ---------------------------------------------------------------- picking

  private initPicking(): void {
    const renderer = this.renderer;
    const camera = this.camera;
    const scene = this.scene;
    if (!renderer || !camera || !scene) return;

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    const down = new THREE.Vector2();
    let dragged = false;

    const element = renderer.domElement;
    element.addEventListener("pointerdown", (event) => {
      down.set(event.clientX, event.clientY);
      dragged = false;
    });
    element.addEventListener("pointermove", (event) => {
      if (Math.hypot(event.clientX - down.x, event.clientY - down.y) > 4) dragged = true;
    });
    element.addEventListener("pointerup", (event) => {
      // A drag is an orbit, not a pick.
      if (dragged) return;
      const rect = element.getBoundingClientRect();
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      const hits = raycaster.intersectObjects(this.meshes, false);
      this.clearHighlight();
      const hit = hits[0];
      if (!hit) {
        this.lastSelection = null;
        this.callbacks.onSelection?.(null);
        return;
      }
      const info = this.describe(hit.object as THREE.Mesh);
      this.lastSelection = info;
      this.highlight(hit.object as THREE.Mesh);
      this.callbacks.onSelection?.(info);
    });
  }

  private highlightMesh: THREE.Mesh | null = null;
  private originalMaterial: THREE.Material | null = null;

  private highlight(mesh: THREE.Mesh): void {
    this.highlightMesh = mesh;
    this.originalMaterial = mesh.material as THREE.Material;
    // NOT oklch(...) — three.js cannot parse that colour model and silently
    // leaves the highlight unset. A hex literal, same as the IFC viewer.
    mesh.material = new THREE.MeshStandardMaterial({
      color: 0x4fd6c0,
      emissive: 0x0d3b36,
      metalness: 0.05,
      roughness: 0.6,
    });
  }

  private clearHighlight(): void {
    if (this.highlightMesh && this.originalMaterial) {
      this.highlightMesh.material = this.originalMaterial;
    }
    this.highlightMesh = null;
    this.originalMaterial = null;
  }

  // ---------------------------------------------------------------- filters

  /** Turn a whole layer (a root prim) on or off. */
  setLayerVisible(layerId: string, visible: boolean): { visible: number; total: number } {
    if (visible) this.activeLayers.add(layerId);
    else this.activeLayers.delete(layerId);
    return this.applyFilters();
  }

  /** Isolate one storey (an IFC path segment). `null` means the whole model. */
  setStorey(storeyId: string | null): { visible: number; total: number } {
    this.activeStorey = storeyId;
    return this.applyFilters();
  }

  private applyFilters(): { visible: number; total: number } {
    const total = this.meshes.length;
    let visible = 0;
    for (const mesh of this.meshes) {
      const usd = userDataOf(mesh);
      const layerOk = this.activeLayers.size === 0 || this.activeLayers.has(usd.rootPrim ?? "");
      const storeyOk = this.activeStorey === null || usd.ifc?.storey === this.activeStorey;
      const on = layerOk && storeyOk;
      mesh.visible = on;
      if (on) visible += 1;
    }
    return { visible, total };
  }

  get visibleCount(): number {
    return this.meshes.filter((mesh) => mesh.visible).length;
  }

  get totalCount(): number {
    return this.meshes.length;
  }

  get modelTitle(): string {
    return this.manifest?.title ?? "USD model";
  }

  get manifestForUi(): UsdManifest | null {
    return this.manifest;
  }

  /** The composed group, for the headless diagnostics only. */
  get rootGroupForDiag(): THREE.Group | null {
    return this.rootGroup;
  }

  /** The live renderer, for the headless diagnostics only. */
  get rendererForDiag(): THREE.WebGLRenderer | null {
    return this.renderer;
  }

  // ---------------------------------------------------------------- public

  /** Snap to a standard view, keeping the current framing. */
  async setView(preset: ViewPreset): Promise<void> {
    const camera = this.camera;
    if (!camera || !this.bounds) return;
    const center = this.bounds.getCenter(new THREE.Vector3());
    const size = this.bounds.getSize(new THREE.Vector3());
    const vFov = (camera.fov * Math.PI) / 180;
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * (camera.aspect || 1));
    const { dir, fit } = VIEW_PRESETS[preset];
    const distance =
      Math.max(
        (fit === "y" ? size.y / 2 / Math.tan(vFov / 2) : size.z / 2 / Math.tan(vFov / 2)),
        fit === "x" ? size.x / 2 / Math.tan(hFov / 2) : 0,
      ) * 1.35;
    this.lookFrom(center, dir, Math.max(distance, 1));
  }

  private async lookFromFace(face: CubeFace): Promise<void> {
    const camera = this.camera;
    if (!camera || !this.bounds) return;
    const center = this.bounds.getCenter(new THREE.Vector3());
    const distance = camera.position.distanceTo(center) || 1;
    const dir = FACE_DIRECTIONS[face].clone();
    // A perfectly vertical direction leaves the camera roll undefined.
    if (dir.y !== 0) dir.z += 0.0001;
    this.lookFrom(center, dir.normalize(), distance);
  }

  /** Frame everything currently visible. */
  frameAll(): { visible: number; total: number } {
    this.measureBounds();
    this.fitCamera();
    return { visible: this.visibleCount, total: this.totalCount };
  }

  setSection(state: SectionState): void {
    const section = this.sectionPlane;
    const scene = this.scene;
    if (!section || !scene) return;
    section.setBounds(this.bounds);
    // Plain three.js materials: the material walk in SectionPlane is the whole
    // mechanism here — no Fragments renderer to hand a plane to.
    section.apply(state, this.renderer ?? undefined);
  }

  /** The USD prim's own attributes, plus what the path encodes. */
  private describe(mesh: THREE.Mesh): UsdPrimInfo {
    const usd = userDataOf(mesh);
    const path = usd.usdPath ?? "";
    const geometry = mesh.geometry;
    const attributes: Record<string, string> = {};
    if (geometry) {
      const position = geometry.getAttribute("position");
      if (position) attributes.points = String(position.count);
      const index = geometry.getIndex();
      const faces = geometry.getAttribute("uv") ? geometry.getAttribute("uv").count : 0;
      attributes.faces = String(faces);
      if (index) attributes.triangles = String(Math.round(index.count / 3));
      geometry.computeBoundingBox();
      const box = geometry.boundingBox;
      if (box) {
        const size = box.getSize(new THREE.Vector3());
        attributes.size = `${size.x.toFixed(2)} × ${size.y.toFixed(2)} × ${size.z.toFixed(2)} m`;
      }
      const material = mesh.material as THREE.Material | undefined;
      if (material) {
        const anyMaterial = material as unknown as Record<string, unknown>;
        attributes.material = String(anyMaterial.name || anyMaterial.type || "default");
      }
    }
    return {
      path,
      rootPrim: usd.rootPrim ?? path.split("/")[1] ?? "",
      name: path.split("/").pop() ?? path,
      ifc: usd.ifc ?? describeIfcPath(path),
      attributes,
    };
  }

  /** Diagnostic surface for the headless verification run. */
  debugCamera(): Record<string, unknown> | null {
    const camera = this.camera;
    const scene = this.scene;
    if (!camera || !scene) return null;
    const round = (v: THREE.Vector3): [number, number, number] =>
      [v.x, v.y, v.z].map((n) => +n.toFixed(1)) as [number, number, number];
    let meshes = 0;
    let visible = 0;
    for (const mesh of this.meshes) {
      meshes += 1;
      if (mesh.visible) visible += 1;
    }
    return {
      cameraPosition: round(camera.position),
      fov: camera.fov,
      meshCount: meshes,
      visibleMeshCount: visible,
      sceneChildren: scene.children.length,
      bounds: this.bounds
        ? {
            min: round(this.bounds.min),
            max: round(this.bounds.max),
            size: round(this.bounds.getSize(new THREE.Vector3())),
          }
        : null,
      manifestMeshCount: this.manifest?.meshCount ?? null,
      // The build step measured this in USD's own Z-up frame; the browser sees
      // Y-up, so a check comparing them has to swap the last two axes.
      manifestBbox: this.manifest?.bbox?.size ?? null,
      /** What the outlier filter dropped, and by how much. */
      rawBounds: this.rawBounds
        ? {
            min: round(this.rawBounds.min),
            max: round(this.rawBounds.max),
            size: round(this.rawBounds.getSize(new THREE.Vector3())),
            outlierLimit: this.outlierLimit,
          }
        : null,
      layers: this.manifest?.layers ?? [],
      activeLayers: [...this.activeLayers],
      storeys: this.manifest?.storeys ?? [],
      activeStorey: this.activeStorey,
      viewCubeMounted: this.viewCube !== null,
      /** Authored lights found and whether they are suppressed. */
      authoredLights: {
        count: this.authoredLights.length,
        suppressed: this.authoredLights.filter((l) => !l.visible).length,
        intensities: this.authoredLights.map((l) => +l.intensity.toFixed(1)),
      },
      toneMapping: this.renderer?.toneMapping ?? null,
      exposure: this.renderer?.toneMappingExposure ?? null,
      sectionReady: this.sectionPlane !== null,
      sectionApplied: this.sectionPlane?.isApplied ?? false,
      /** Materials that currently carry a clipping plane — proves the cut landed. */
      clippedMaterials: (() => {
        let count = 0;
        this.scene?.traverse((obj) => {
          const mesh = obj as THREE.Mesh;
          if (!mesh.isMesh) return;
          const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
          if (!material) return;
          for (const entry of Array.isArray(material) ? material : [material]) {
            if (entry?.clippingPlanes?.length) count += 1;
          }
        });
        return count;
      })(),
      renderInfo: this.renderer
        ? { ...(this.renderer.info.render as unknown as Record<string, number>) }
        : null,
      selection: this.lastSelection
        ? { path: this.lastSelection.path, ifc: this.lastSelection.ifc }
        : null,
    };
  }

  dispose(): void {
    cancelAnimationFrame(this.frameHandle);
    this.controls?.dispose();
    this.renderer?.dispose();
    this.renderer?.domElement?.remove();
    this.viewCube?.element.remove();
    this.meshes = [];
    this.byPath.clear();
    this.scene = null;
    this.camera = null;
    this.renderer = null;
    this.rootGroup = null;
  }
}

/**
 * What a prim path encodes about the IFC element behind it.
 *
 * The IFC-derived prims nest as
 *   /House/tn__ProjectNumber_qD/Default/Default/<STOREY>/<CATEGORY>/<NAME>…/Mesh
 * so the storey is segment 5 and the category segment 6. Rooms appear as an
 * extra segment (`IFCSPACE/WC/…`).
 */
export function describeIfcPath(path: string): UsdIfcPathInfo {
  const parts = path.split("/").filter(Boolean);
  const root = parts[0] ?? "";
  const out: UsdIfcPathInfo = { storey: null, category: null, room: null, element: null };
  if (root !== HOUSE_ROOT || parts.length <= CATEGORY_SEGMENT) return out;
  out.storey = parts[STOREY_SEGMENT - 1] ?? null;
  out.category = parts[CATEGORY_SEGMENT - 1] ?? null;
  // The segment after the category is a room when the category is a space,
  // otherwise it is the element's own name.
  const after = parts[CATEGORY_SEGMENT];
  if (after && after !== "Mesh" && !after.startsWith("IFC")) out.room = null;
  out.element = after ?? null;
  return out;
}
