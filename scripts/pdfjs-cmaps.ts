import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";

/** Publish PDF.js's matching CMaps locally, including their redistribution notice. */
export function pdfjsCmaps(): Plugin {
  const packageRoot = path.dirname(fileURLToPath(import.meta.resolve("pdfjs-dist/package.json")));
  const source = path.join(packageRoot, "cmaps");
  let assetPrefix: string;
  let files: Set<string>;

  return {
    name: "texlite-pdfjs-cmaps",
    async configResolved() {
      const { version } = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8")) as { version: string };
      assetPrefix = `assets/pdfjs-${version}/cmaps/`;
      files = new Set((await readdir(source)).filter((name) => name.endsWith(".bcmap") || name === "LICENSE"));
    },
    configureServer(server) {
      const prefix = `${server.config.base}${assetPrefix}`;
      // The filename allowlist also prevents requests from escaping cmaps/.
      server.middlewares.use((request, response, next) => {
        const pathname = request.url?.split("?")[0] ?? "";
        if ((request.method !== "GET" && request.method !== "HEAD") || !pathname.startsWith(prefix)) return next();
        const name = pathname.slice(prefix.length);
        if (!files.has(name)) return next();
        void readFile(path.join(source, name)).then((content) => {
          response.writeHead(200, {
            "Content-Type": name.endsWith(".bcmap") ? "application/octet-stream" : "text/plain; charset=utf-8",
            "Content-Length": content.length,
            "Cache-Control": "public, max-age=31536000, immutable"
          });
          response.end(request.method === "HEAD" ? undefined : content);
        }, next);
      });
    },
    async generateBundle() {
      await Promise.all([...files].map(async (name) => {
        this.emitFile({ type: "asset", fileName: `${assetPrefix}${name}`, source: await readFile(path.join(source, name)) });
      }));
    }
  };
}
