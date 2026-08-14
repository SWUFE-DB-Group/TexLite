import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  root: "src/client",
  build: {
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
