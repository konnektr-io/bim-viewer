/**
 * Viewer state.
 *
 * Zustand rather than component state: the engine is a long-lived imperative
 * object outside React, and the store is the bridge between the two.
 */
import { create } from "zustand";

import type { Format, LoadStatus, Room, Selection, Storey } from "@/viewer/types";
import type { AssetNode } from "@/components/AssetTree";
import type { ViewPreset } from "@/viewer/viewPresets";
import {
  DEFAULT_SECTION,
  type SectionState,
} from "@/viewer/sectionPlane";

interface ViewerState {
  format: Format;
  status: LoadStatus;
  modelTitle: string;
  storeys: Storey[];
  rooms: Room[];
  activeStorey: number | null;
  activeView: ViewPreset;
  selection: Selection | null;
  visibleCount: number | null;
  totalCount: number | null;
  section: SectionState;
  tree: AssetNode[];
  isolatedNodeId: string | null;

  setTree: (tree: AssetNode[]) => void;
  setIsolatedNode: (id: string | null) => void;
  setFormat: (format: Format) => void;
  setModelTitle: (title: string) => void;
  setLoading: (detail: string) => void;
  setReady: (info: {
    elementCount: number;
    storeys: Storey[];
    rooms: Room[];
  }) => void;
  setError: (message: string) => void;
  setStorey: (localId: number | null) => void;
  setActiveView: (view: ViewPreset) => void;
  setSelection: (selection: Selection | null) => void;
  setVisibility: (visible: number, total: number) => void;
  setSection: (patch: Partial<SectionState>) => void;
  resetSection: () => void;
}

export const useViewerStore = create<ViewerState>((set) => ({
  format: "ifc",
  status: { state: "idle" },
  modelTitle: "BIM model",
  storeys: [],
  rooms: [],
  activeStorey: null,
  activeView: "iso",
  selection: null,
  visibleCount: null,
  totalCount: null,
  section: DEFAULT_SECTION,
  tree: [],
  isolatedNodeId: null,

  setTree: (tree) => set({ tree }),
  setIsolatedNode: (isolatedNodeId) => set({ isolatedNodeId }),

  setFormat: (format) => set({ format, selection: null }),

  setModelTitle: (modelTitle) => set({ modelTitle }),

  setLoading: (detail) => set({ status: { state: "loading", detail } }),

  setReady: ({ elementCount, storeys, rooms }) =>
    set({
      status: {
        state: "ready",
        elementCount,
        spaceCount: rooms.length,
        storeyCount: storeys.length,
      },
      storeys,
      rooms,
      visibleCount: elementCount,
      totalCount: elementCount,
    }),

  setError: (message) => set({ status: { state: "error", message } }),

  setStorey: (activeStorey) => set({ activeStorey, selection: null }),

  setActiveView: (activeView) => set({ activeView }),

  setSelection: (selection) => set({ selection }),

  setVisibility: (visibleCount, totalCount) => set({ visibleCount, totalCount }),

  setSection: (patch) => set((state) => ({ section: { ...state.section, ...patch } })),

  resetSection: () => set({ section: DEFAULT_SECTION }),
}));
