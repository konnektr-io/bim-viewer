/**
 * Section (clip) plane.
 *
 * WHY THIS IS ITS OWN MODULE, AND WHY IT IS NOT IFC-SPECIFIC
 * ----------------------------------------------------------
 * This clips by assigning `material.clippingPlanes` on the three.js materials
 * in the scene — the same mechanism OBC's `Clipper` uses, but driven directly
 * instead of through a draggable gizmo. Nothing here imports
 * `@thatopen/fragments` or deals in localIds, so the future USD viewer can
 * reuse it unchanged as long as it renders three.js materials.
 *
 * It drives the materials itself rather than delegating to `Clipper` because
 * `Clipper` only re-assigns `clippingPlanes` when a plane is DRAGGED
 * (`onAfterDrag`). A plane placed programmatically with
 * `createFromNormalAndCoplanarPoint` is created but its materials are never
 * updated, which is why the first version of this showed no cut at all.
 *
 * AXIS CONVENTION
 * ---------------
 * The scene is **Y-up** (the IFC importer converts Z-up to Y-up), so a storey is
 * cut by a plane whose normal is along Y. WHICH SIDE SURVIVES is decided by the
 * SIGN OF THE NORMAL, not by a separate flip flag: negating the normal keeps
 * the other half. That is the "see above / see below" control, and why `side` is
 * part of the state.
 */
import * as THREE from "three";

export type SectionAxis = "y" | "x" | "z";

export interface SectionState {
  /** Clipping active. When false every material is left unclipped. */
  enabled: boolean;
  /** Which model axis the plane's normal lies on. */
  axis: SectionAxis;
  /**
   * Plane position along the axis as a FRACTION (0..1) of the model extent on
   * that axis, measured from the low end. A fraction rather than a world
   * coordinate so the control keeps working when the bounds change, and so
   * "halfway up the house" means the same thing for every model.
   */
  offset: number;
  /**
   * Which side of the plane is kept. "negative" keeps the half BELOW the plane
   * on the axis, "positive" keeps the half ABOVE. This is the above/below
   * control.
   */
  side: "negative" | "positive";
}

export const DEFAULT_SECTION: SectionState = {
  enabled: false,
  axis: "y",
  offset: 0.5,
  side: "negative",
};

/** A normal along `axis`, pointing in the direction implied by `side`. */
export function sectionNormal(axis: SectionAxis, side: SectionState["side"]): THREE.Vector3 {
  const sign = side === "positive" ? 1 : -1;
  switch (axis) {
    case "x":
      return new THREE.Vector3(sign, 0, 0);
    case "z":
      return new THREE.Vector3(0, 0, sign);
    case "y":
    default:
      return new THREE.Vector3(0, sign, 0);
  }
}

export class SectionPlane {
  /** The live plane handed to three.js. Mutated in place, never replaced. */
  readonly plane = new THREE.Plane(new THREE.Vector3(0, -1, 0), 0);
  private readonly scene: THREE.Object3D;
  private extent = new THREE.Vector3();
  private center = new THREE.Vector3();
  private applied = false;
  /** What the fragments renderer reads. Empty array = no clipping. */
  private clipSource: THREE.Plane[] = [];

  constructor(scene: THREE.Object3D) {
    this.scene = scene;
  }

  /** Record the model bounds so the 0..1 offset maps onto real coordinates. */
  setBounds(box: THREE.Box3 | null): void {
    // A null/empty box must NOT clear what is already known: `worldPointFor`
    // maps the 0..1 offset onto `this.extent`/`this.center`, so leaving them at
    // their zero defaults silently places the plane at the world origin instead
    // of failing. Returning early keeps the last good bounds, which is what the
    // caller means when it re-applies a section after a bounds measurement that
    // produced nothing.
    if (!box || box.isEmpty()) return;
    this.extent = box.getSize(new THREE.Vector3());
    this.center = box.getCenter(new THREE.Vector3());
  }

  /**
   * The world point the plane passes through, from the 0..1 offset. The plane
   * sits at the same place for both sides; only the normal flips, which is what
   * decides which half survives.
   */
  private worldPointFor(state: SectionState): THREE.Vector3 {
    const axis = state.axis;
    const size = axis === "x" ? this.extent.x : axis === "z" ? this.extent.z : this.extent.y;
    const low =
      axis === "x"
        ? this.center.x - size / 2
        : axis === "z"
          ? this.center.z - size / 2
          : this.center.y - size / 2;
    const clamped = Math.min(1, Math.max(0, state.offset));
    const point = this.center.clone();
    const value = low + size * clamped;
    if (axis === "x") point.x = value;
    else if (axis === "z") point.z = value;
    else point.y = value;
    return point;
  }

  /**
   * Push a state change into the scene.
   *
   * IMPORTANT — WHY THIS IS NOT JUST `material.clippingPlanes`
   * -----------------------------------------------------------
   * Fragments does not draw the model with stock three.js materials. It uses
   * custom outline-style passes and a WebGL tiling renderer, so setting
   * `clippingPlanes` on the materials has no effect: the measured triangle
   * count stays identical at every section offset. The supported hook is
   * `FragmentsModel.getClippingPlanesEvent`, a function the renderer calls when
   * it needs the active planes. Assigning the live plane array here is what
   * actually cuts the model.
   *
   * The material walk is kept as well, so the section still works for any plain
   * three.js content in the same scene — which is what the future USD viewer
   * will be.
   */
  apply(state: SectionState, renderer?: THREE.WebGLRenderer): void {
    if (renderer) renderer.localClippingEnabled = true;

    const normal = sectionNormal(state.axis, state.side);
    const point = this.worldPointFor(state);
    this.plane.setFromNormalAndCoplanarPoint(normal, point);

    // Fragments: hand the live plane to the renderer. An empty array disables
    // clipping, so the same setter covers both directions.
    this.clipSource = state.enabled ? [this.plane] : [];

    const seen = new Set<THREE.Material>();
    this.scene.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh) return;
      const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
      if (!material) return;
      for (const entry of Array.isArray(material) ? material : [material]) {
        if (!entry || seen.has(entry)) continue;
        seen.add(entry);
        if (state.enabled) {
          entry.clippingPlanes = [this.plane];
          entry.clipShadows = true;
          entry.needsUpdate = true;
        } else if (entry.clippingPlanes?.length) {
          entry.clippingPlanes = null;
          entry.needsUpdate = true;
        }
      }
    });
    this.applied = state.enabled;
  }

  /**
   * Give the fragments model its clipping-plane source. Called once after the
   * model is loaded; `onChange` should request a redraw.
   */
  attachFragmentsModel(model: unknown): void {
    const target = model as { getClippingPlanesEvent?: unknown };
    if (!target || typeof target.getClippingPlanesEvent !== "function") {
      console.warn("FragmentsModel has no getClippingPlanesEvent; section will not cut");
      return;
    }
    // Assign through the property so the library's own setter runs.
    (target as { getClippingPlanesEvent: () => THREE.Plane[] }).getClippingPlanesEvent =
      () => this.clipSource;
  }

  /** True once a cut is in force. */
  get isApplied(): boolean {
    return this.applied;
  }

  dispose(): void {
    this.apply({ ...DEFAULT_SECTION, enabled: false });
  }
}
