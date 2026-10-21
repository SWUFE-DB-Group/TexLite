import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { brotliCompressSync, brotliDecompressSync, gzipSync, gunzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/server/app.js";
import { loadConfig } from "../src/server/config.js";
import { openDatabase, type DatabaseConnection } from "../src/server/db.js";

describe.each(["/", "/tools/texlite"])("precompressed production assets at %s", (basePath) => {
  let root: string;
  let db: DatabaseConnection;
  let app: FastifyInstance;
  const script = Buffer.from("globalThis.example = 'TexLite';\n".repeat(150));
  const wasm = Buffer.alloc(8192, 3);
  const url = (relative: string) => `${basePath === "/" ? "" : basePath}${relative}`;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "texlite-static-assets-"));
    const configPath = path.join(root, "config.json");
    fs.writeFileSync(configPath, JSON.stringify({ storage: { dataDir: root }, server: { basePath }, updates: { enabled: false } }));
    const config = { ...loadConfig(configPath), clientDir: path.join(root, "client") };
    fs.mkdirSync(path.join(config.clientDir, "assets"), { recursive: true });
    fs.writeFileSync(path.join(config.clientDir, "index.html"), '<html><head><base href="/" /><meta name="texlite-base-path" content="/" /></head></html>');
    fs.writeFileSync(path.join(config.clientDir, "assets", "legacy.js"), "export {};\n");
    for (const [name, content] of [["app-deadbeef.js", script], ["pdf.worker.min.mjs", script], ["formatter.wasm", wasm]] as const) {
      const file = path.join(config.clientDir, "assets", name);
      fs.writeFileSync(file, content);
      fs.writeFileSync(`${file}.gz`, gzipSync(content));
      fs.writeFileSync(`${file}.br`, brotliCompressSync(content));
    }
    db = openDatabase(config);
    app = await buildApp(config, db, { logger: false });
  });
  afterAll(async () => { await app?.close(); db?.close(); if (root) fs.rmSync(root, { recursive: true, force: true }); });

  it.each([
    ["br, gzip", "br"], ["gzip", "gzip"], ["br;q=0, gzip", "gzip"],
    ["br;q=0.5, gzip;q=1", "gzip"], ["identity", undefined], [undefined, undefined]
  ] as const)("negotiates %s while keeping MIME, cache policy and the original URL", async (acceptEncoding, encoding) => {
    const response = await app.inject({ method: "GET", url: url("/assets/app-deadbeef.js"), headers: acceptEncoding ? { "accept-encoding": acceptEncoding } : {} });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-encoding"]).toBe(encoding);
    expect(response.headers["content-type"]).toMatch(/javascript/);
    expect(response.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect(response.headers.vary).toContain("accept-encoding");
    const decoded = encoding === "br" ? brotliDecompressSync(response.rawPayload) : encoding === "gzip" ? gunzipSync(response.rawPayload) : response.rawPayload;
    expect(decoded).toEqual(script);
    expect(response.headers["content-length"]).toBe(String(response.rawPayload.length));
  });

  it.each(["br", "gzip"])("serves Worker and WASM assets with %s and their original MIME types", async (encoding) => {
    for (const [name, content, mime] of [["pdf.worker.min.mjs", script, /javascript/], ["formatter.wasm", wasm, /^application\/wasm/]] as const) {
      const response = await app.inject({ method: "GET", url: url(`/assets/${name}`), headers: { "accept-encoding": encoding } });
      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toMatch(mime);
      expect(response.headers["content-encoding"]).toBe(encoding);
      expect((encoding === "br" ? brotliDecompressSync : gunzipSync)(response.rawPayload)).toEqual(content);
    }
  });

  it("supports HEAD and conditional requests for a compressed representation", async () => {
    const assetUrl = url("/assets/app-deadbeef.js");
    const headers = { "accept-encoding": "gzip" };
    const get = await app.inject({ method: "GET", url: assetUrl, headers });
    const head = await app.inject({ method: "HEAD", url: assetUrl, headers });
    expect(head.statusCode).toBe(200);
    expect(head.rawPayload.length).toBe(0);
    expect(head.headers["content-encoding"]).toBe("gzip");
    expect(head.headers["content-length"]).toBe(get.headers["content-length"]);
    expect(get.headers.etag).toBeTruthy();
    const cached = await app.inject({ method: "GET", url: assetUrl, headers: { ...headers, "if-none-match": String(get.headers.etag) } });
    expect(cached.statusCode).toBe(304);
    expect(cached.rawPayload.length).toBe(0);
    expect(cached.headers.vary).toContain("accept-encoding");
  });

  it("falls back for older assets and does not compress API responses or the runtime-rendered shell", async () => {
    const headers = { "accept-encoding": "br, gzip" };
    const legacy = await app.inject({ method: "GET", url: url("/assets/legacy.js"), headers });
    expect(legacy.statusCode).toBe(200);
    expect(legacy.headers["content-encoding"]).toBeUndefined();
    expect(legacy.body).toBe("export {};\n");
    expect(legacy.headers.vary).toContain("accept-encoding");
    const shell = await app.inject({ method: "GET", url: url("/project/example"), headers });
    expect(shell.headers["content-encoding"]).toBeUndefined();
    expect(shell.headers["cache-control"]).toBe("no-store");
    expect(shell.body).toContain(`<base href="${basePath === "/" ? "/" : `${basePath}/`}" />`);
    const api = await app.inject({ method: "GET", url: url("/api/config"), headers });
    expect(api.statusCode).toBe(200);
    expect(api.headers["content-encoding"]).toBeUndefined();
  });
});
