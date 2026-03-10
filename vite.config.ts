// vite.config.ts  –  MERICA Sovereign v9.0
// Build all React HUDs into a single NUI bundle.

import { defineConfig } from "vite";
import react            from "@vitejs/plugin-react";
import path             from "path";

export default defineConfig({
  plugins: [react()],

  root: "react",

  resolve: {
    alias: {
      // "@merica/shared/..." maps to "./shared/..."
      "@merica/shared": path.resolve(__dirname, "react/shared"),
    },
  },

  build: {
    outDir:   "../html",
    emptyOutDir: true,
    rollupOptions: {
      input:  path.resolve(__dirname, "react/main.tsx"),
      output: {
        entryFileNames: "main.js",
        chunkFileNames: "main.js",
        assetFileNames: (info) => info.name?.endsWith(".css") ? "main.css" : info.name ?? "[name]",
        // Single chunk — FiveM NUI cannot load dynamic imports
        inlineDynamicImports: true,
      },
    },
    sourcemap: false,
    minify:    "esbuild",
  },

  define: {
    // Suppress React prod warnings in NUI context
    "process.env.NODE_ENV": JSON.stringify("production"),
  },
});
