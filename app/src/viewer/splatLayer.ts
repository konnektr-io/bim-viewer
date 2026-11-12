import * as THREE from "three";
import { SplatMesh, SparkRenderer } from "@sparkjsdev/spark";

/**
 * Places a Gaussian splat inside a scene that was authored elsewhere (the USD
 * house), so the two can be judged against each other.
 *
 * WHY SPARK AND NOT @mkkellogg/gaussian-splats-3d
 * The latter only exports its own `Viewer`/`DropInViewer` — there is no
 * `SplatMesh` in its published module build, so it cannot be added to a scene
 * that already exists (this one, with the house in it). Spark exports a real
 * `THREE.Object3D` and peers `three >=0.180`, which is what this app runs.
 *
 * WHY A TRANSFORM WITH THREE SEPARATE SCALES
 * The splat is not metrically similar to the house. Measured on a real capture:
 * anchoring length by the room area gave 0.539 m/unit while anchoring height by
 * the 2.5 m ceiling gave 0.781 m/unit — a 1.45x anisotropy. A single uniform
 * scale therefore cannot fit it, and pretending otherwise produces a fit that is
 * wrong in one axis no matter what you do. So the model here is non-uniform on
 * purpose: scaleX/Y/Z, a yaw about the vertical, and a translation.
 */
export interface SplatTransform {
  scaleX: number;
  scaleY: number;
  scaleZ: number;
  /** Rotation about the scene's vertical axis, in degrees. */
  yawDeg: number;
  /** Rotation about X, in degrees. -90 converts the Z-up splat into a Y-up
   *  scene; +90 does the same but keeps the cloud the other way up, which is
   *  what you want when the reconstruction's vertical axis came out inverted. */
  tiltDeg: number;
  tx: number;
  ty: number;
  tz: number;
}

export const IDENTITY_SPLAT_TRANSFORM: SplatTransform = {
  scaleX: 1,
  scaleY: 1,
  scaleZ: 1,
  yawDeg: 0,
  tiltDeg: -90,
  tx: 0,
  ty: 0,
  tz: 0,
};

export interface SplatLayerStatus {
  url: string;
  splatCount: number;
  transform: SplatTransform;
}

export class SplatLayer {
  private readonly scene: THREE.Scene;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly requestRender?: () => void;
  private spark: SparkRenderer | null = null;
  private mesh: SplatMesh | null = null;
  private transform: SplatTransform = { ...IDENTITY_SPLAT_TRANSFORM };
  private url: string | null = null;

  constructor(
    scene: THREE.Scene,
    renderer: THREE.WebGLRenderer,
    /** Called when Spark needs a frame (sort order or LoD settled). */
    requestRender?: () => void,
  ) {
    // Field assignment rather than constructor parameter properties: this
    // project compiles with `erasableSyntaxOnly`, which forbids them.
    this.scene = scene;
    this.renderer = renderer;
    this.requestRender = requestRender;
  }

  get isLoaded(): boolean {
    return this.mesh !== null;
  }

  get status(): SplatLayerStatus | null {
    if (!this.mesh || !this.url) return null;
    return {
      url: this.url,
      splatCount: this.mesh.numSplats ?? 0,
      transform: { ...this.transform },
    };
  }

  /**
   * Load a .spz/.ply/.splat and attach it. Replaces any previous splat.
   * Resolves once the splats are parsed, so a caller can report a real count
   * instead of "it didn't throw".
   */
  async load(url: string, transform?: Partial<SplatTransform>): Promise<SplatLayerStatus> {
    this.unload();
    if (!this.spark) {
      this.spark = new SparkRenderer({
        renderer: this.renderer,
        onDirty: () => this.requestRender?.(),
      });
      // Spark draws through this object; if it is culled the splats vanish even
      // though the mesh is in view, so it must never be frustum-culled.
      this.spark.frustumCulled = false;
      this.scene.add(this.spark);
    }
    const mesh = new SplatMesh({ url });
    mesh.frustumCulled = false;
    this.mesh = mesh;
    this.url = url;
    this.scene.add(mesh);
    await mesh.initialized;
    if (transform) Object.assign(this.transform, transform);
    this.apply();
    return this.status as SplatLayerStatus;
  }

  setTransform(patch: Partial<SplatTransform>): SplatTransform {
    Object.assign(this.transform, patch);
    this.apply();
    return { ...this.transform };
  }

  /** Current transform, or the identity if nothing is loaded. */
  getTransform(): SplatTransform {
    return { ...this.transform };
  }

  /** Drop the splat but keep the Spark renderer attached. */
  unload(): void {
    if (!this.mesh) return;
    this.scene.remove(this.mesh);
    this.mesh.dispose();
    this.mesh = null;
    this.url = null;
    this.requestRender?.();
  }

  dispose(): void {
    this.unload();
    if (this.spark) {
      this.scene.remove(this.spark);
      this.spark.dispose();
      this.spark = null;
    }
  }

  /** Debug hooks for headless verification: what actually reached the scene. */
  get debug(): { mesh: SplatMesh | null; spark: SparkRenderer | null } {
    return { mesh: this.mesh, spark: this.spark };
  }

  private apply(): void {
    if (!this.mesh) return;
    const t = this.transform;
    this.mesh.scale.set(t.scaleX, t.scaleY, t.scaleZ);
    // The splat file is Z-up (same convention as the USD stage), but the scene
    // is three.js Y-up: the USD composer converts the house with
    // `rootGroup.rotation.x = -PI/2`. Without the same conversion here the cloud
    // is displayed lying on its side, and yaw about Y cannot fix a tilt — the
    // reported symptom was "it's on its side and I couldn't rotate".
    // Order 'YXZ' composes as Ry(yaw) * Rx(-90deg) * Rz, i.e. stand it upright
    // first, then spin it about the world's vertical axis.
    this.mesh.rotation.order = "YXZ";
    this.mesh.rotation.set(
      THREE.MathUtils.degToRad(t.tiltDeg),
      THREE.MathUtils.degToRad(t.yawDeg),
      0,
    );
    this.mesh.position.set(t.tx, t.ty, t.tz);
    this.mesh.updateMatrixWorld(true);
    this.requestRender?.();
  }
}

/** Read a transform out of URL query params: ?splat=...&sx=..&sy=..&sz=..&yaw=..&tx=..&ty=..&tz=.. */
export function transformFromParams(params: URLSearchParams): Partial<SplatTransform> {
  const num = (key: string): number | undefined => {
    const raw = params.get(key);
    if (raw === null || raw === "") return undefined;
    const v = Number(raw);
    return Number.isFinite(v) ? v : undefined;
  };
  const out: Partial<SplatTransform> = {};
  const sx = num("sx"), sy = num("sy"), sz = num("sz");
  const yaw = num("yaw");
  const tilt = num("tilt");
  const tx = num("tx"), ty = num("ty"), tz = num("tz");
  if (sx !== undefined) out.scaleX = sx;
  if (sy !== undefined) out.scaleY = sy;
  if (sz !== undefined) out.scaleZ = sz;
  if (yaw !== undefined) out.yawDeg = yaw;
  if (tilt !== undefined) out.tiltDeg = tilt;
  if (tx !== undefined) out.tx = tx;
  if (ty !== undefined) out.ty = ty;
  if (tz !== undefined) out.tz = tz;
  return out;
}
