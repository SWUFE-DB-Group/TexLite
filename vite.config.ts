import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import wasm from "vite-plugin-wasm";
import { loadBasePath } from "./src/server/config.js";
import { basePathHref } from "./src/shared/basePath.js";

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
    optimizeDeps: {
      // This dependency is only imported by a Worker, so the initial scan
      // misses it. Pre-bundle it to avoid reloading the page on first format.
      include: ["tex-fmt"]
    },
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
      rolldownOptions: {
        output: {
          // Keep heavy editor/PDF modules behind their existing lazy imports.
          // Only React's core runtime belongs in the initial shared chunk;
          // react-* feature packages retain their own route boundaries.
          codeSplitting: {
            groups: [
              // Vite's shared preload helper must not be captured recursively
              // by the PDF group, which would eagerly load PDF.js on login.
              { name: "vite-runtime", test: /\0vite\/.*helper/, priority: 10 },
              { name: "pdf", test: /[\\/]node_modules[\\/]pdfjs-dist[\\/]/ },
              { name: "editor", test: /[\\/]node_modules[\\/](?:@codemirror|@lezer)[\\/]/ },
              { name: "react", test: /[\\/]node_modules[\\/](?:react|react-dom|scheduler)[\\/]/ }
            ]
          }
        }
      }
    },
    server: {
      host: "127.0.0.1",
      port: 5173,
      proxy: {
        [apiPrefix]: {
          target: `http://127.0.0.1:${process.env.TEXLITE_DEV_SERVER_PORT ?? "3000"}`,
          ws: true
        }
      }
    }
  };
});
