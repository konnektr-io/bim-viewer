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
 * WHY A USDZ PACKAGE AND NOT THE PLAIN FLATTEN
 * --------------------------------------------
 * `USDLoader` populates its `assets` map ONLY from a `.usdz` package. On a
 * standalone file it composes with an empty assets dict, so
 * `USDComposer._loadTexture` finds nothing and every `UsdUVTexture` silently
 * falls back to a flat scalar colour. `cad/package_web_usdz.py` packs the
 * flatten (first entry, per the USDZ rule) plus its PNGs, and this fetches
 * `/api/usd/scene.usdz` as an ArrayBuffer parsed with basePath `""`.
 * The composer additionally requires `inputs:file` on each `UsdUVTexture`
 * (`_getTextureFromConnection` returns null without it); the packager authors
 * it, mirroring the existing `info:default:sourceAsset`.
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
import type { AssetNode } from "@/components/AssetTree";

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
 * Use the lights the scene was AUTHORED with, in addition to the neutral rig.
 *
 * This was `false` on a wrong inference and is now `true` on a measurement. The
 * reasoning that flipped it:
 *
 *  - I assumed the authored rig (6 `UsdLuxRectLight` at intensities 17.5-286.5,
 *    plus a `DomeLight`) was the cause of the white blowout, and suppressed it.
 *    That fixed the blowout and caused the opposite failure: the model went
 *    underexposed, with large pure-black regions.
 *  - `pxr` then showed where those lights actually ARE: all 7 come from
 *    `bathroom_design.usd`, and the 6 rect lights are 0.26-2.2 m across, sitting
 *    inside a 3.5 m2 bathroom in a 28 m house. They are ROOM lighting. Treating
 *    a 2.2 m fixture as a 28 m house light was the error.
 *  - An A/B of the real configurations settled it. With ACES tone mapping ON,
 *    the authored rig as-is gives 0.00% saturated at luma 140 — brighter and
 *    clean. With tone mapping OFF it gives **9.14% saturated**: the original
 *    blowout. The rig was never the cause; the missing tone curve was.
 *
 * So: keep the authored rig, keep ACES, and let the neutral rig underneath
 * stand in as ambient the authored rig does not provide for the exterior.
 */
const USE_AUTHORED_LIGHTS = true;

/**
 * Cap on a single authored light's intensity, in the units USD reports.
 *
 * Measured, not guessed. With the rig restored and ACES on, the frame was clean
 * (0.00% saturated) but `nearWhite` rose to 3.60% — and a 10x8 spatial grid
 * showed that was **one single pixel**, in one cell. So it was a LOCAL hot spot,
 * not a global exposure problem, and the fix had to be local: the offender is
 * `daylight` at intensity 286.5, sitting 0.2-2.6 m from the bathroom surfaces it
 * lights. The other five are 12.7-17.5, i.e. an order of magnitude lower.
 *
 * Measured across caps, all with ACES on:
 *
 *   cap      near-white   luma
 *    none       3.60%     137.6    <- one blown pixel
 *     60        0.02%     113.7
 *     30        0.00%     108.2    <- chosen: fully clean, still well lit
 *     20        0.00%     105.7
 *
 * 30 is the smallest reduction that reaches a completely clean frame, so it is
 * the one that keeps as much of the authored lighting as possible. The authored
 * values are preserved on `userData`; this is a display concern, not an edit to
 * the scene.
 */
const AUTHORED_LIGHT_INTENSITY_CAP = 30;

/**
 * The sky's colours and strength, and why this is a gradient rather than
 * `RoomEnvironment`.
 *
 * Measured on this scene, black faces as a share of MODEL pixels (the earlier
 * probes that reported 0.00% were filtering the dark viewport background as
 * though it were model — see the note in the comment at the assignment):
 *
 *   no environment        black 3.25-35.62%   sat 0.00%
 *   RoomEnvironment 0.55  black 3.25-29.60%   sat 15.01%   <- worse: it blows out
 *   sky gradient          (see the verification in the README)
 *
 * The dark faces are not a lighting-DIRECTION problem: 52.6% of the 1450 meshes
 * face away from every directional light, and a further 19.2% have a very dark
 * base colour (the bathroom's `212124` bodies have a base luminance of 0.016), so
 * whatever light they do receive rounds to black. Raising the directional or
 * hemisphere intensity cannot fix that — it brightens the already-lit faces and
 * blows them out instead. Only direction-INDEPENDENT light can, which is what an
 * environment map is for.
 */
const SKY_COLOR = 0xbfd0e6;
const GROUND_COLOR = 0x4a5058;
const ENVIRONMENT_INTENSITY = 1.6;

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
  /**
   * The prefiltered sky, held so the composer's materials can be given it AFTER
   * they exist. `scene.environment` alone is not enough: three.js binds it when a
   * material is first rendered, and the composer creates its materials during
   * `parse()`, before this is assigned.
   */
  private skyEnvironment: THREE.Texture | null = null;
  private manifest: UsdManifest | null = null;
  private bounds: THREE.Box3 | null = null;
  /** Unfiltered union, diagnostics only. */
  private rawBounds: THREE.Box3 | null = null;
  /** The span above which a mesh is treated as a broken outlier, diagnostics. */
  private outlierLimit: number | null = null;
  private lastSelection: UsdPrimInfo | null = null;
  private activeLayers = new Set<string>();
  private activeStorey: string | null = null;
  /** Set by `selectNode`; narrows visibility to one tree node. */
  private isolateTo: ((mesh: THREE.Mesh) => boolean) | null = null;
  private isolatedNode: string | null = null;
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
    //
    // THE BLACK FACES — and why an environment light is the fix.
    //
    // Measured on this scene: **52.6% of the 1450 meshes face away from every
    // directional light**, and `scene.environment` was `None`. A face like that
    // receives only the hemisphere term, which for a downward- or side-facing
    // surface is close to the ground colour, so it renders near-black. On top of
    // that, 19.2% of meshes have a very dark base colour (the bathroom's
    // `212124` bodies have a base luminance of 0.016), so any weak lighting shows
    // as pure black rather than as a dark shade.
    //
    // Raising the ambient or the directional intensities does not fix this — it
    // brightens the already-lit faces and blows them out while the away-facing
    // ones stay black. An environment light is the right tool: it is
    // **direction-independent**, so a surface gets lit from every orientation,
    // and it gives `MeshStandardMaterial`/`MeshPhysicalMaterial` the indirect
    // diffuse the authored scene assumes but the viewer had none of.
    //
    // `RoomEnvironment` is generated, not a downloaded HDR, so this costs no
    // network request and no asset. It is an approximation of a neutral studio
    // and is set on `scene.environment` with an intensity that the measurement
    // below pins down — deliberately NOT on `scene.background`, so the dark
    // viewport background stays and the model does not.
    //
    // A GRADIENT, not `RoomEnvironment`.
    //
    // `RoomEnvironment` was the obvious choice and it is wrong here: it is built
    // from emissive-white area lights (see three.js `createAreaLightMaterial`,
    // `emissiveIntensity`), so it measures at 15.01% saturated pixels — it
    // reintroduces the blowout from a different direction. Measured against it:
    // black 3.25-29.60%, sat 15.01%.
    //
    // What a real scene wants is a SOFT SKY: bright from above, dark from below.
    // A vertical gradient encodes exactly that, costs nothing, and its two
    // intensities are the only tuning knobs. Built through PMREM because
    // `scene.environment` needs a prefiltered cube.
    const skyScene = new THREE.Scene();
    const skyGeo = new THREE.SphereGeometry(1, 32, 16);
    // vertexColors on a BackSide sphere: +Y = sky, -Y = ground
    const colors: number[] = [];
    const pos = skyGeo.getAttribute("position");
    const top = new THREE.Color(SKY_COLOR);
    const bottom = new THREE.Color(GROUND_COLOR);
    for (let i = 0; i < pos.count; i += 1) {
      const t = (pos.getY(i) + 1) / 2; // 0 at the nadir, 1 at the zenith
      const c = bottom.clone().lerp(top, t * t);
      colors.push(c.r, c.g, c.b);
    }
    skyGeo.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    const skyMat = new THREE.MeshBasicMaterial({
      side: THREE.BackSide,
      vertexColors: true,
      toneMapped: false,
    });
    const skyMesh = new THREE.Mesh(skyGeo, skyMat);
    skyScene.add(skyMesh);

    const pmrem = new THREE.PMREMGenerator(renderer);
    const environment = pmrem.fromScene(skyScene, 0.02);
    scene.environment = environment.texture;
    scene.environmentIntensity = ENVIRONMENT_INTENSITY;
    // Held so the materials the composer creates during parse() can be given it
    // explicitly — see the note where they are bound.
    this.skyEnvironment = environment.texture;
    skyGeo.dispose();
    skyMat.dispose();
    pmrem.dispose();

    // A weak hemisphere alongside the gradient. Measured: with the gradient
    // alone the frame sat at luma 20-22.5 with black up to 57% — a
    // MeshBasicMaterial sky through PMREM arrives at its own radiance, which is
    // not enough to lift a 0.016 base-colour surface off zero. The hemisphere is
    // the flat ambient term; the gradient supplies the directional variation.
    scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x4a5058, 0.9));

    // Key and fill, kept subtle. With the environment doing the ambient work,
    // these only need to shape the form.
    const key = new THREE.DirectionalLight(0xffffff, 1.1);
    key.position.set(1, 2, 1.4);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xdfe4ea, 0.3);
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

    this.callbacks.onProgress?.("Fetching the USDZ package…");
    const res = await fetch("/api/usd/scene.usdz");
    if (!res.ok) {
      throw new Error(`Failed to fetch the USD scene: HTTP ${res.status}`);
    }
    const buf = await res.arrayBuffer(); // NOT .text() — the PK check needs bytes
    // The SPA fallback answers unknown /api paths with HTTP 200 + HTML, which
    // reads as false success. Verify the bytes, not just res.ok.
    const magic = new Uint8Array(buf.slice(0, 2));
    if (magic[0] !== 0x50 || magic[1] !== 0x4b) {
      throw new Error(
        `The USD scene is not a USDZ package (first bytes ` +
          `${magic[0]?.toString(16)} ${magic[1]?.toString(16)}) — refusing to parse`,
      );
    }

    this.callbacks.onProgress?.(
      `USDZ received (${(buf.byteLength / 1e6).toFixed(1)} MB) — composing meshes…`,
    );
    const loader = new USDLoader();
    // The composer is synchronous and heavy (~15 s of parse for the 39 MB
    // package), so yield to the browser first or the status line never paints.
    await new Promise((resolve) => setTimeout(resolve, 16));
    // "" (not "/") for a package: the loader passes the zip's own basePath.
    const group = loader.parse(buf, "", undefined, undefined) as THREE.Group;
    if (!group) throw new Error("The USD layer composed to nothing");

    // The single most important number in the USDZ change: textures only exist
    // if the package resolved. Reported BEFORE the environment bind below, so
    // the sky envMap cannot pollute the count.
    this.reportTextures(group);

    this.rootGroup = group;
    scene.add(group);

    // NOW apply the environment. `scene.environment` reaches a material when it
    // is first rendered, and the USD composer creates its own
    // `MeshPhysicalMaterial` instances during `parse()` — so setting the
    // environment before the load leaves every one of them with `envMap === null`
    // and the whole thing has no effect. Measured: `withEnv: 0` of 1450 meshes
    // when set early.
    group.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh) return;
      const material = mesh.material as THREE.MeshStandardMaterial | undefined;
      if (material && "envMap" in material && !material.envMap) {
        material.envMap = this.skyEnvironment;
        material.envMapIntensity = 1.0;
        material.needsUpdate = true;
      }
    });

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
      light.visible = USE_AUTHORED_LIGHTS;
      if (light.intensity > AUTHORED_LIGHT_INTENSITY_CAP) {
        // Keep the authored value so this is reversible and inspectable.
        light.userData.__authoredIntensity = light.intensity;
        light.intensity = AUTHORED_LIGHT_INTENSITY_CAP;
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
   * Count the distinct THREE.Texture objects the composer actually created.
   *
   * `composer.texturePromises` is internal, so the composed result is
   * traversed instead. Runs BEFORE the environment bind, so the sky envMap
   * cannot pollute the count. If this is 0 the USDZ change has not worked,
   * whatever else passes: the wiring is right but the image bytes never
   * resolved.
   *
   * Colour space needs no logic here, only verification: the composer
   * hardcodes SRGBColorSpace for `inputs:diffuseColor` and NoColorSpace for
   * normal/occlusion/roughness/metallic, ignoring the authored
   * `colorSpace:name` — and the USD opinions are already correct.
   */
  private reportTextures(group: THREE.Group): void {
    const seen = new Map<THREE.Texture, { slot: string; mesh: string }>();
    group.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh) return;
      const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
      const materials = material === undefined ? [] : Array.isArray(material) ? material : [material];
      for (const entry of materials) {
        for (const [slot, value] of Object.entries(entry)) {
          if (slot === "envMap") continue;
          if (value instanceof THREE.Texture && !seen.has(value)) {
            seen.set(value, { slot, mesh: mesh.name });
          }
        }
      }
    });
    const lines = [...seen.entries()].map(([tex, where]) => {
      const label = tex.name || (tex.image as { src?: string } | undefined)?.src?.slice(-64) || "(unnamed)";
      return `  ${label} slot=${where.slot} mesh=${where.mesh} colorSpace=${tex.colorSpace}`;
    });
    console.info(`[usd] textures composed: ${seen.size}\n${lines.join("\n")}`);
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
      // `pickables()`, not `meshes`: the section plane clips in the shader, so a
      // clipped-away mesh is still a raycast hit and would be selectable while
      // invisible.
      const hits = raycaster.intersectObjects(this.pickables(), false);
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
      const on = layerOk && storeyOk && (!this.isolateTo || this.isolateTo(mesh));
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

  /** True when a mesh is non-indexed, so a probe knows the vertex layout. */
  get geometryStats(): { meshes: number; indexed: number; nonIndexed: number; withNormals: number } {
    let indexed = 0, nonIndexed = 0, withNormals = 0, meshes = 0;
    this.meshes.forEach((m) => {
      meshes += 1;
      if (m.geometry.index) indexed += 1;
      else nonIndexed += 1;
      const n = m.geometry.getAttribute('normal');
      if (n && n.count) withNormals += 1;
    });
    return { meshes, indexed, nonIndexed, withNormals };
  }

  /** Exposed so a probe can raycast without importing three itself. */
  get __threeForRaycast(): typeof THREE {
    return THREE;
  }

  /** The live camera, so a probe can orbit without synthesising input events. */
  get __cameraForDiag(): THREE.PerspectiveCamera | null {
    return this.camera;
  }

  /**
   * How many meshes the raycaster would treat as pickable.
   *
   * `raycaster.intersectObjects` does NOT know about `material.clippingPlanes`:
   * a shader-clipped mesh is still submitted and still hit, so the section plane
   * hides geometry WITHOUT removing it from picking. That is why a click can
   * select a roof the user has just cut away. `pickables()` is the honest list,
   * and picking uses it.
   */
  get pickableCount(): number {
    return this.pickables().length;
  }

  /**
   * The model as a browsable tree.
   *
   * Built from the prim paths already recorded in `indexPrims`, grouped by the
   * storey and IFC-category path segments. That grouping is not in the flattened
   * file any more — the manifest carries the counts, but not the parent/child
   * shape — so it is reconstructed here from the paths, which is the only place
   * the hierarchy still exists.
   *
   * Structure: layer (root prim) -> storey -> category -> element, with rooms
   * inserted under the storey where the path carries one. A root prim that is
   * not IFC (the bathroom) gets a single synthetic storey so it is still
   * browsable.
   */
  buildTree(): AssetNode[] {
    const layerOf = new Map<string, AssetNode>();
    const byStorey = new Map<string, Map<string, AssetNode>>();

    for (const mesh of this.meshes) {
      const usd = userDataOf(mesh);
      const path = usd.usdPath;
      if (!path) continue;
      const root = usd.rootPrim ?? "House";
      const ifc = usd.ifc ?? describeIfcPath(path);

      let layer = layerOf.get(root);
      if (!layer) {
        layer = { id: root, label: root, kind: "layer", count: 0 };
        layerOf.set(root, layer);
        byStorey.set(root, new Map());
      }
      layer.count += 1;

      const storeyKey = `${root}/${ifc.storey ?? "(other)"}`;
      let storeys = byStorey.get(root);
      if (!storeys) {
        storeys = new Map();
        byStorey.set(root, storeys);
      }
      let storey = storeys.get(ifc.storey ?? "(other)");
      if (!storey) {
        storey = {
          id: storeyKey,
          label: ifc.storey ?? "(other)",
          kind: "storey",
          count: 0,
          children: [],
        };
        storeys.set(ifc.storey ?? "(other)", storey);
      }
      storey.count += 1;

      // `catKey` already includes the storey, so it is unique per storey. The
      // dedup counter was global, which suffixed the SAME category on a second
      // storey (`IFCWALL`, `IFCWALL#1`, …) instead of finding the existing
      // node — measured as 708 `category` rows under one storey where there are
      // only 16 categories in the model.
      const catId = `${storeyKey}/${ifc.category ?? "Mesh"}`;
      void catId;

      let category = storey.children?.find((c) => c.id === catId);
      if (!category) {
        category = {
          id: catId,
          label: ifc.category ?? "Mesh",
          kind: "category",
          count: 0,
          children: [],
        };
        storey.children?.push(category);
      }
      category.count += 1;
      category.children?.push({
        id: path,
        label: ifc.element ?? mesh.name ?? path,
        kind: "element",
        count: 1,
      });
    }

    const roots: AssetNode[] = [];
    for (const [root, layer] of layerOf) {
      const storeys = byStorey.get(root);
      layer.children = storeys ? [...storeys.values()] : [];
      // Largest first: the storeys you look at are the big ones.
      layer.children.sort((a, b) => b.count - a.count);
      for (const s of layer.children) {
        s.children?.sort((a, b) => b.count - a.count);
      }
      roots.push(layer);
    }
    roots.sort((a, b) => b.count - a.count);
    return roots;
  }

  /**
   * Isolate a tree node.
   *
   * Resolves the node's id back to the meshes under it. `element` ids are prim
   * paths (exact), `category` ids are storey+category, `storey`/`layer` are
   * prefixes — so one predicate covers every level, and it is applied to the same
   * `userData` the picking already uses rather than to a second index.
   */
  async selectNode(node: AssetNode): Promise<{ visible: number; total: number }> {
    if (node.kind === "element") {
      this.isolateTo = (mesh) => userDataOf(mesh).usdPath === node.id;
    } else if (node.kind === "category") {
      const [layer, storey, category] = node.id.split("/");
      this.isolateTo = (mesh) => {
        const usd = userDataOf(mesh);
        const ifc = usd.ifc ?? describeIfcPath(usd.usdPath ?? "");
        return (
          (usd.rootPrim === layer || !layer) &&
          (ifc.storey === storey || !storey) &&
          (ifc.category === category || !category)
        );
      };
    } else if (node.kind === "storey") {
      const [layer, storey] = node.id.split("/");
      this.isolateTo = (mesh) => {
        const usd = userDataOf(mesh);
        const ifc = usd.ifc ?? describeIfcPath(usd.usdPath ?? "");
        return (usd.rootPrim === layer || !layer) && (ifc.storey === storey || !storey);
      };
    } else {
      // layer
      this.isolateTo = (mesh) => userDataOf(mesh).rootPrim === node.id;
    }
    this.isolatedNode = node.id;
    return this.applyFilters();
  }

  /** Clear an isolation and go back to the layer/storey filters alone. */
  async clearIsolation(): Promise<{ visible: number; total: number }> {
    this.isolateTo = null;
    this.isolatedNode = null;
    return this.applyFilters();
  }

  get isolatedNodeId(): string | null {
    return this.isolatedNode;
  }

  /** Meshes a raycast can legitimately hit, i.e. not shader-clipped away. */
  private pickables(): THREE.Mesh[] {
    if (!this.sectionPlane?.isApplied) return this.meshes;
    const plane = this.sectionPlane.plane;
    const out: THREE.Mesh[] = [];
    const target = new THREE.Vector3();
    for (const mesh of this.meshes) {
      if (!mesh.visible) continue;
      if (!mesh.geometry?.boundingBox) mesh.geometry.computeBoundingBox();
      const box = mesh.geometry?.boundingBox;
      if (!box || box.isEmpty()) continue;
      // Cheap accept/reject: if the box's nearest point is on the kept side of
      // the plane, some of this mesh survives, so keep it pickable.
      box.getCenter(target);
      if (plane.distanceToPoint(target) < 0) continue;
      out.push(mesh);
    }
    return out;
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
        visible: this.authoredLights.filter((l) => l.visible).length,
        capped: this.authoredLights.filter(
          (l) => l.userData.__authoredIntensity !== undefined,
        ).length,
        intensities: this.authoredLights.map((l) => +l.intensity.toFixed(1)),
        authoredIntensities: this.authoredLights.map(
          (l) => +(l.userData.__authoredIntensity ?? l.intensity).toFixed(1),
        ),
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
