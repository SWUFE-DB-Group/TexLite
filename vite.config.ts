import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import wasm from "vite-plugin-wasm";
import { loadBasePath } from "./src/server/config";
import { basePathHref } from "./src/shared/basePath";

function developmentHtmlBase(basePath: string) {
  const href = basePathHref(basePath);
  return {
    name: "texlite-development-base-path",
    transformIndexHtml(html: string) {
      return html
        .replace(/<base\s+href=(?:"[^"]*"|'[^']*')\s*\/?\s*>/i, `<base href="${href}" />`)
        .replace(/<meta\s+name=(?:"texlite-base-path"|'texlite-base-path')\s+content=(?:"[^"]*"|'[^']*')\s*\/?\s*>/i, `<meta name="texlite-base-path" content="${basePath}" />`);
    }
  };
}

export default defineConfig(({ command }) => {
  // Production uses relative asset URLs so one package build can be mounted
  // at any runtime server.basePath. During development, read the exact same
  // configuration as the API server so Vite serves and proxies that prefix.
  const developmentBasePath = command === "serve" ? loadBasePath() : "/";
  const developmentBaseHref = basePathHref(developmentBasePath);
  const apiPrefix = `${developmentBasePath === "/" ? "" : developmentBasePath}/api/`;
  return {
    base: command === "serve" ? developmentBaseHref : "./",
    plugins: [developmentHtmlBase(developmentBasePath), react(), wasm()],
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
        [apiPrefix]: {
          target: "http://127.0.0.1:3000",
          ws: true
        }
      }
    }
  };
});
