import { fileURLToPath, URL } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react-swc";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    // ESM: __dirname does not exist, so derive it from import.meta.url.
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  build: {
    target: "es2022",
    // The wasm and worker must stay real files, never inlined as data URIs.
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 4096,
    rollupOptions: {
      output: {
        manualChunks: {
          three: ["three"],
          thatopen: ["@thatopen/components", "@thatopen/components-front"],
        },
      },
    },
  },
  worker: { format: "es" },
  server: {
    host: "0.0.0.0",
    port: 5173,
    // In dev, the FastAPI backend serves the model; forward it.
    proxy: { "/api": { target: "http://127.0.0.1:8080", changeOrigin: true } },
  },
});
