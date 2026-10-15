import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";

/**
 * Default entries are kept: src/main/index.ts, src/preload/index.ts and
 * src/renderer/index.html. `tinycode` is a real dependency, so it is
 * externalized from the main bundle and resolved from the workspace root at
 * runtime — the desktop host always runs the harness the repo built.
 */
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
  },
  renderer: {
    plugins: [
      react({
        // No tsconfig.json at the app root, so set the runtime explicitly:
        // babel's classic default emits `React.createElement`, which breaks.
        jsxRuntime: "automatic",
        jsxImportSource: "react",
      }),
    ],
  },
});
