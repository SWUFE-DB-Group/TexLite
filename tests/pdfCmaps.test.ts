import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import { build, createServer } from "vite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pdfjsCmaps } from "../scripts/pdfjs-cmaps.js";

const packageRoot = path.dirname(fileURLToPath(import.meta.resolve("pdfjs-dist/package.json")));
const { version } = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8")) as { version: string };
const assetPrefix = `assets/pdfjs-${version}/cmaps/`;
const sampleName = "Adobe-GB1-UCS2.bcmap";
const sample = fs.readFileSync(path.join(packageRoot, "cmaps", sampleName));

describe("bundled PDF character maps", () => {
  let root: string;

  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "texlite-pdf-cmaps-")); });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it("includes the matching CMaps and redistribution notice in the production build", async () => {
    fs.writeFileSync(path.join(root, "index.html"), "<!doctype html><title>PDF assets</title>");
    const result = await build({
      configFile: false, root, base: "./", logLevel: "silent", plugins: [pdfjsCmaps()],
      build: { write: false, minify: false }
    });
    if (Array.isArray(result) || !("output" in result)) throw new Error("Expected a single build output");
    const emitted = result.output.filter((item) => item.type === "asset" && item.fileName.startsWith(assetPrefix));
    expect(emitted.map((item) => item.fileName).sort()).toEqual(
      fs.readdirSync(path.join(packageRoot, "cmaps"))
        .filter((name) => name.endsWith(".bcmap") || name === "LICENSE")
        .map((name) => `${assetPrefix}${name}`).sort()
    );
    const cmap = emitted.find((item) => item.fileName === `${assetPrefix}${sampleName}`);
    expect(cmap?.type === "asset" && Buffer.from(cmap.source)).toEqual(sample);
    const license = emitted.find((item) => item.fileName === `${assetPrefix}LICENSE`);
    expect(license?.type === "asset" && Buffer.from(license.source).toString("utf8"))
      .toContain("Adobe Systems Incorporated");
  });

  it.each(["/", "/tools/texlite/"])("serves binary maps below the development base %s", async (base) => {
    const server = await createServer({
      configFile: false, root, base, logLevel: "silent", plugins: [pdfjsCmaps()], appType: "custom",
      server: { middlewareMode: true, hmr: false, watch: null }, optimizeDeps: { noDiscovery: true }
    });
    const app = Fastify();
    app.all("/*", (request, reply) => {
      reply.hijack();
      server.middlewares(request.raw, reply.raw, () => {
        reply.raw.statusCode = 404;
        reply.raw.end();
      });
    });
    try {
      const url = `${base}${assetPrefix}${sampleName}`;
      const response = await app.inject({ method: "GET", url: `${url}?test=1` });
      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toBe("application/octet-stream");
      expect(response.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
      expect(response.rawPayload).toEqual(sample);
      const head = await app.inject({ method: "HEAD", url });
      expect(head.statusCode).toBe(200);
      expect(head.rawPayload.length).toBe(0);
      expect(head.headers["content-length"]).toBe(String(sample.length));
      expect((await app.inject({ method: "GET", url: `${base}${assetPrefix}missing.bcmap` })).statusCode).toBe(404);
      expect((await app.inject({ method: "GET", url: `${base}${assetPrefix}../package.json` })).statusCode).toBe(404);
    } finally {
      await app.close();
      await server.close();
    }
  });
});
