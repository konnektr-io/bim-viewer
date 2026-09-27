/**
 * Camera view presets — a lightweight stand-in for a full view cube.
 *
 * AXIS CONVENTION: the Fragments scene is **Y-up** (three.js), even though the
 * IFC source is Z-up. The importer applies the coordinate conversion, so the
 * scene you orbit in has +Y as vertical. Getting this backwards is why a "top"
 * view renders the storey from underneath — the symptom is a plan view that
 * shows whatever is above the cut plane instead of below it.
 */
import * as THREE from "three";

export type ViewPreset = "iso" | "front" | "back" | "left" | "right" | "top" | "bottom";

export interface ViewPresetDef {
  label: string;
  /** Direction FROM the target TOWARD the camera. */
  dir: THREE.Vector3;
  /** Which model axis must fit the frustum: "x" = width, "y" = height. */
  fit: "x" | "y";
}

const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z).normalize();

export const VIEW_PRESETS: Record<ViewPreset, ViewPresetDef> = {
  iso: { label: "Isometric", dir: v(1, 0.8, 1), fit: "x" },
  // "Front" looks along -Z, so the camera sits on +Z.
  front: { label: "Front", dir: v(0, 0, 1), fit: "x" },
  back: { label: "Back", dir: v(0, 0, -1), fit: "x" },
  left: { label: "Left", dir: v(-1, 0, 0), fit: "x" },
  right: { label: "Right", dir: v(1, 0, 0), fit: "x" },
  // Top looks DOWN, so the camera sits at +Y. A tiny Z keeps the basis stable
  // (a perfectly vertical direction makes an undefined camera orientation).
  top: { label: "Top", dir: v(0, 1, 0.0001), fit: "x" },
  bottom: { label: "Bottom", dir: v(0, -1, 0.0001), fit: "x" },
};

export const VIEW_PRESET_ORDER: ViewPreset[] = [
  "iso",
  "front",
  "back",
  "left",
  "right",
  "top",
  "bottom",
];
