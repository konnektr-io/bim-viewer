/**
 * A minimal view cube: an orientation indicator you can click to snap the camera
 * to a standard view.
 *
 * WHY THIS IS HOME-MADE RATHER THAN `@thatopen/ui-obc`'s `bim-view-cube`
 * ---------------------------------------------------------------------
 * ThatOpen does ship a view cube — the tutorial you linked points at
 * `engine_ui-components`, published as `@thatopen/ui-obc`. It is a custom
 * element that pulls in a chunk of ThatOpen's web-components styling and
 * expects its own `<bim-viewport>` container. This viewer drives a plain
 * three.js scene that the future USD viewer will share, so the cube is built
 * directly on three.js: it works for any renderer, needs no custom-element
 * runtime, and adds no dependency that is tied to one file format.
 *
 * The cube is a SECOND scene rendered into its own small canvas, so it never
 * disturbs the main scene's lights, materials or background.
 */
import * as THREE from "three";

export type CubeFace = "front" | "back" | "left" | "right" | "top" | "bottom";

/** Face label drawn on the cube, in screen-space pixel offsets. */
const FACE_LABELS: Array<{ face: CubeFace; text: string; color: string; offset: [number, number] }> = [
  { face: "front", text: "FRONT", color: "#0f172a", offset: [0, 34] },
  { face: "back", text: "BACK", color: "#0f172a", offset: [0, 34] },
  { face: "left", text: "LEFT", color: "#0f172a", offset: [38, 0] },
  { face: "right", text: "RIGHT", color: "#0f172a", offset: [38, 0] },
  { face: "top", text: "TOP", color: "#0f172a", offset: [0, 62] },
  { face: "bottom", text: "BOTTOM", color: "#0f172a", offset: [0, 62] },
];

/** Direction FROM the model TOWARD the camera for each standard view. */
export const FACE_DIRECTIONS: Record<CubeFace, THREE.Vector3> = {
  front: new THREE.Vector3(0, 0, 1),
  back: new THREE.Vector3(0, 0, -1),
  left: new THREE.Vector3(-1, 0, 0),
  right: new THREE.Vector3(1, 0, 0),
  top: new THREE.Vector3(0, 1, 0),
  bottom: new THREE.Vector3(0, -1, 0),
};

export interface ViewCubeOptions {
  /** CSS pixel size of the square cube widget. */
  size?: number;
  /** Called when the user clicks a face. */
  onSelect?: (face: CubeFace) => void;
}

export class ViewCube {
  readonly element: HTMLDivElement;
  private readonly size: number;
  private readonly onSelect?: (face: CubeFace) => void;

  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(-1.7, 1.7, 1.7, -1.7, 0.1, 100);
  private readonly pivot = new THREE.Group();
  private readonly raycaster = new THREE.Raycaster();
  private readonly faces: Array<{ mesh: THREE.Mesh; face: CubeFace }> = [];
  private readonly onPointerMove = (event: PointerEvent) => this.handleHover(event);
  private readonly onPointerDown = (event: PointerEvent) => this.handleClick(event);
  private readonly onPointerLeave = () => this.resetHover();
  private disposed = false;

  constructor(options: ViewCubeOptions = {}) {
    this.size = options.size ?? 132;
    this.onSelect = options.onSelect;

    this.element = document.createElement("div");
    this.element.style.cssText = [
      "position:absolute",
      "right:3rem", // clear of the right-hand panel, which is ~24rem wide
      "top:3rem",
      "z-index:5",
      `width:${this.size}px`,
      `height:${this.size}px`,
      "pointer-events:auto",
      "user-select:none",
      "touch-action:none",
      "opacity:0.92",
    ].join(";");

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(this.size, this.size);
    this.renderer.domElement.style.cssText =
      "display:block;width:100%;height:100%;border-radius:8px;cursor:pointer;";
    this.element.append(this.renderer.domElement);

    this.buildCube();
    this.camera.position.set(0, 0, 5);
    this.camera.lookAt(0, 0, 0);

    this.renderer.domElement.addEventListener("pointermove", this.onPointerMove);
    this.renderer.domElement.addEventListener("pointerdown", this.onPointerDown);
    this.renderer.domElement.addEventListener("pointerleave", this.onPointerLeave);
  }

  private buildCube(): void {
    const half = 0.75;
    const size = half * 2;
    // Per-face materials so a hovered face can be highlighted on its own.
    const make = (): THREE.MeshLambertMaterial =>
      new THREE.MeshLambertMaterial({ color: 0xe2e8f0, transparent: true, opacity: 0.94 });

    const panels: Array<{ face: CubeFace; geometry: THREE.PlaneGeometry; position: [number, number, number]; rotation: [number, number, number] }> = [
      { face: "front", geometry: new THREE.PlaneGeometry(size, size), position: [0, 0, half], rotation: [0, 0, 0] },
      { face: "back", geometry: new THREE.PlaneGeometry(size, size), position: [0, 0, -half], rotation: [0, Math.PI, 0] },
      { face: "right", geometry: new THREE.PlaneGeometry(size, size), position: [half, 0, 0], rotation: [0, Math.PI / 2, 0] },
      { face: "left", geometry: new THREE.PlaneGeometry(size, size), position: [-half, 0, 0], rotation: [0, -Math.PI / 2, 0] },
      { face: "top", geometry: new THREE.PlaneGeometry(size, size), position: [0, half, 0], rotation: [-Math.PI / 2, 0, 0] },
      { face: "bottom", geometry: new THREE.PlaneGeometry(size, size), position: [0, -half, 0], rotation: [Math.PI / 2, 0, 0] },
    ];

    for (const panel of panels) {
      const mesh = new THREE.Mesh(panel.geometry, make());
      mesh.position.set(...panel.position);
      mesh.rotation.set(...panel.rotation);
      mesh.userData.face = panel.face;
      mesh.userData.baseColor = 0xe2e8f0;
      this.pivot.add(mesh);
      this.faces.push({ mesh, face: panel.face });
    }

    this.scene.add(this.pivot);
    this.scene.add(new THREE.AmbientLight(0xffffff, 1.5));
    const key = new THREE.DirectionalLight(0xffffff, 2);
    key.position.set(3, 4, 5);
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0xffffff, 0.6);
    fill.position.set(-4, -2, -3);
    this.scene.add(fill);
  }

  /**
   * Mirror the main camera's orientation.
   *
   * The cube is rotated by the INVERSE of the camera's world rotation, so the
   * face pointing at the viewer is always the side they are looking at. Copying
   * the camera quaternion directly is the classic bug here: it shows where the
   * camera IS, not where it is LOOKING.
   */
  updateOrientation(camera: THREE.Camera): void {
    if (this.disposed) return;
    this.pivot.quaternion.copy(camera.quaternion).invert();
    this.pivot.updateMatrixWorld();
    this.renderer.render(this.scene, this.camera);
  }

  private pick(event: PointerEvent): CubeFace | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const pointer = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(pointer, this.camera);
    const hits = this.raycaster.intersectObjects(this.faces.map((f) => f.mesh), false);
    const face = hits[0]?.object.userData.face;
    return typeof face === "string" ? (face as CubeFace) : null;
  }

  private handleHover(event: PointerEvent): void {
    const face = this.pick(event);
    for (const entry of this.faces) {
      const material = entry.mesh.material as THREE.MeshLambertMaterial;
      const base = entry.mesh.userData.baseColor as number;
      material.color.setHex(entry.face === face ? 0x14b8a6 : base);
    }
    this.renderer.domElement.style.cursor = face ? "pointer" : "default";
    this.updateOrientationFromLast();
  }

  private updateOrientationFromLast(): void {
    // Hovering only changes colours, but the render must be redone to show them.
    this.renderer.render(this.scene, this.camera);
  }

  private handleClick(event: PointerEvent): void {
    const face = this.pick(event);
    if (face) this.onSelect?.(face);
  }

  private resetHover(): void {
    for (const entry of this.faces) {
      const material = entry.mesh.material as THREE.MeshLambertMaterial;
      material.color.setHex(entry.mesh.userData.baseColor as number);
    }
    this.updateOrientationFromLast();
  }

  /** Overlay text for the faces, drawn in DOM so it stays crisp at any DPR. */
  labels(): HTMLDivElement {
    const layer = document.createElement("div");
    layer.style.cssText = "position:absolute;inset:0;pointer-events:none;";
    for (const label of FACE_LABELS) {
      const node = document.createElement("span");
      node.textContent = label.text;
      node.style.cssText = [
        "position:absolute",
        "font-size:8px",
        "letter-spacing:0.08em",
        "font-weight:600",
        "color:#0f172a",
        "transform:translate(-50%,-50%)",
        "opacity:0.75",
      ].join(";");
      node.dataset.face = label.face;
      layer.append(node);
    }
    this.element.append(layer);
    return layer;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const canvas = this.renderer.domElement;
    canvas.removeEventListener("pointermove", this.onPointerMove);
    canvas.removeEventListener("pointerdown", this.onPointerDown);
    canvas.removeEventListener("pointerleave", this.onPointerLeave);
    this.faces.forEach(({ mesh }) => {
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
    });
    this.renderer.dispose();
    this.element.remove();
  }
}
