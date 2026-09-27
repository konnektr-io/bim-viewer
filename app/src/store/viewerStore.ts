/**
 * Viewer state.
 *
 * Zustand rather than component state: the engine is a long-lived imperative
 * object outside React, and the store is the bridge between the two.
 */
import { create } from "zustand";

import type { Format, LoadStatus, Room, Selection, Storey } from "@/viewer/types";

interface ViewerState {
  format: Format;
  status: LoadStatus;
  storeys: Storey[];
  rooms: Room[];
  activeStorey: number | null;
  selection: Selection | null;
  visibleCount: number | null;
  totalCount: number | null;

  setFormat: (format: Format) => void;
  setLoading: (detail: string) => void;
  setReady: (info: {
    elementCount: number;
    storeys: Storey[];
    rooms: Room[];
  }) => void;
  setError: (message: string) => void;
  setStorey: (localId: number | null) => void;
  setSelection: (selection: Selection | null) => void;
  setVisibility: (visible: number, total: number) => void;
}

export const useViewerStore = create<ViewerState>((set) => ({
  format: "ifc",
  status: { state: "idle" },
  storeys: [],
  rooms: [],
  activeStorey: null,
  selection: null,
  visibleCount: null,
  totalCount: null,

  setFormat: (format) => set({ format, selection: null }),

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

  setSelection: (selection) => set({ selection }),

  setVisibility: (visible, total) => set({ visibleCount: visible, totalCount: total }),
}));
