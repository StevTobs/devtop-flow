import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// DevTop Flow — Vite config tuned for Tauri
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    // src-tauri/target holds Cargo's build output — files there get
    // locked/rewritten mid-compile, and on Windows that throws EBUSY through
    // Vite's fs watcher and crashes the whole dev server outright.
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
  envPrefix: ["VITE_", "TAURI_"],
  // Baked in at build time so the running app can show exactly which build
  // it is — otherwise a stale install/webview cache looks identical to a
  // fresh one until something silently doesn't work.
  define: {
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
  build: {
    target: "esnext",
    minify: "esbuild",
    sourcemap: true,
  },
});
