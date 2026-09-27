import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import App from "@/App";
import "@/index.css";

const container = document.getElementById("root");
if (!container) throw new Error("#root not found");

// Dark by default: the brand palette is only fully populated in `.dark`
// (same tokens as graph-explorer / ktrlplane).
document.documentElement.classList.add("dark");

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
