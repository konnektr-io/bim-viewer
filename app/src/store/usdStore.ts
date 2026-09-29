/**
 * USD view state.
 *
 * Separate from the IFC store on purpose: the two tabs load different files with
 * different shapes, and sharing one store would mean every IFC selector had to
 * cope with USD-only fields. The shared parts (the section plane state, the view
 * preset) are typed per store and driven through the same components.
 */
import { create } from "zustand";

import type { UsdGroup, UsdLayer, UsdLoadStatus, UsdPrimInfo } from "@/viewer/usdTypes";
import { DEFAULT_SECTION, type SectionState } from "@/viewer/sectionPlane";

interface UsdState {
  status: UsdLoadStatus;
  modelTitle: string;
  layers: UsdLayer[];
  storeys: UsdGroup[];
  /** Layer ids currently shown. Every layer starts visible. */
  visibleLayers: Set<string>;
  activeStorey: string | null;
  activeView: string;
  selection: UsdPrimInfo | null;
  visibleCount: number | null;
  totalCount: number | null;
  section: SectionState;

  setModelTitle: (title: string) => void;
  setLoading: (detail: string) => void;
  setReady: (info: { meshCount: number; layers: UsdLayer[]; storeys: UsdGroup[] }) => void;
  setError: (message: string) => void;
  setLayerVisible: (layerId: string, visible: boolean) => void;
  showAllLayers: () => void;
  setStorey: (storeyId: string | null) => void;
  setActiveView: (view: string) => void;
  setSelection: (selection: UsdPrimInfo | null) => void;
  setVisibility: (visible: number, total: number) => void;
  setSection: (patch: Partial<SectionState>) => void;
  resetSection: () => void;
}

export const useUsdStore = create<UsdState>((set) => ({
  status: { state: "idle" },
  modelTitle: "USD model",
  layers: [],
  storeys: [],
  visibleLayers: new Set<string>(),
  activeStorey: null,
  activeView: "iso",
  selection: null,
  visibleCount: null,
  totalCount: null,
  section: DEFAULT_SECTION,

  setModelTitle: (modelTitle) => set({ modelTitle }),

  setLoading: (detail) => set({ status: { state: "loading", detail } }),

  setReady: ({ meshCount, layers, storeys }) =>
    set({
      status: { state: "ready", meshCount, layerCount: layers.length },
      layers,
      storeys,
      visibleLayers: new Set(layers.map((layer) => layer.id)),
      visibleCount: meshCount,
      totalCount: meshCount,
      selection: null,
    }),

  setError: (message) => set({ status: { state: "error", message } }),

  setLayerVisible: (layerId, visible) =>
    set((state) => {
      const next = new Set(state.visibleLayers);
      if (visible) next.add(layerId);
      else next.delete(layerId);
      return { visibleLayers: next };
    }),

  showAllLayers: () => set((state) => ({ visibleLayers: new Set(state.layers.map((l) => l.id)) })),

  setStorey: (activeStorey) => set({ activeStorey, selection: null }),

  setActiveView: (activeView) => set({ activeView }),

  setSelection: (selection) => set({ selection }),

  setVisibility: (visibleCount, totalCount) => set({ visibleCount, totalCount }),

  setSection: (patch) => set((state) => ({ section: { ...state.section, ...patch } })),

  resetSection: () => set({ section: DEFAULT_SECTION }),
}));
