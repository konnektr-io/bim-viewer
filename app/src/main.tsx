import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import App from "@/App";
import { formatFromPath } from "@/lib/formatRoute";
import { useViewerStore } from "@/store/viewerStore";
import "@/index.css";

const container = document.getElementById("root");
if (!container) throw new Error("#root not found");

// Dark by default: the brand palette is only fully populated in `.dark`
// (same tokens as graph-explorer / ktrlplane).
document.documentElement.classList.add("dark");

// Back and Forward move between the views, because the format owns a real
// history entry (see `syncUrl`). Without this the URL would follow the tab but
// the tab would ignore the URL, and Back would leave the app entirely.
//
// Handled through the store, NOT through `setFormat`: the store's setter also
// pushes a history entry, and reacting to a navigation by pushing another one
// traps the user in a loop they can only leave by hand.
window.addEventListener("popstate", () => {
  const format = formatFromPath(window.location.pathname);
  // An unknown path (or `/` itself) means IFC — the same default a cold load
  // applies, so a history entry is never a state the app cannot show.
  useViewerStore.setState({ format: format ?? "ifc", selection: null });
});

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
