import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import wasm from "vite-plugin-wasm";

export default defineConfig({
  plugins: [react(), wasm()],
  worker: {
    // Worker bundles use their own plugin pipeline. tex-fmt is deliberately
    // loaded there so both its WASM execution and diff calculation stay off
    // the editor's main thread.
    plugins: () => [wasm()],
    format: "es"
  },
  root: "src/client",
  build: {
    // tex-fmt's WASM module uses native top-level await. TexLite targets
    // current browsers, so retaining it avoids a fragile post-build rewrite.
    target: "esnext",
    outDir: "../../dist/client",
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("node_modules/pdfjs-dist")) return "pdf";
          if (id.includes("node_modules/@codemirror") || id.includes("node_modules/@lezer")) return "editor";
          if (id.includes("node_modules/react")) return "react";
        }
      }
    }
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/api/": {
        target: "http://127.0.0.1:3000",
        ws: true
      }
    }
  }
});
