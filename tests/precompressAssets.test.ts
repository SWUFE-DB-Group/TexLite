import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { build, type Plugin } from "vite";
import { describe, expect, it } from "vitest";
import { precompressAssets } from "../scripts/precompress-assets.js";

describe("build-time static asset compression", () => {
  it("compresses final chunks, CSS, Workers and WASM while preserving originals and skipping unsuitable files", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "texlite-precompress-"));
    const fixtures: Record<string, string | Uint8Array> = {
      "assets/theme.css": ".example { color: #176b44; background: white; }\n".repeat(150),
      "assets/formatter.wasm": Buffer.alloc(8192, 3),
      "assets/pdf.worker.min.mjs": "globalThis.example = 'worker';\n".repeat(150),
      "assets/tiny.js": "export {};",
      "assets/incompressible.wasm": randomBytes(8192),
      "assets/example.pdf": "%PDF-1.4\n".repeat(1024),
      "assets/example.zip": "archive".repeat(1024),
      "assets/photo.jpg": "image".repeat(1024),
      "assets/logo.svg": "<svg></svg>".repeat(1024),
      "assets/font.woff2": "font".repeat(1024),
      "assets/maps/example.bcmap": "packed map".repeat(1024),
      "assets/main.js.map": "source map".repeat(1024),
      "outside.js": "globalThis.example = 'outside';\n".repeat(150)
    };
    const fixtureAssets: Plugin = {
      name: "fixture-assets",
      generateBundle() {
        for (const [fileName, source] of Object.entries(fixtures)) this.emitFile({ type: "asset", fileName, source });
      }
    };
    try {
      fs.writeFileSync(path.join(root, "index.html"), '<!doctype html><script type="module" src="/main.js"></script>');
      fs.writeFileSync(path.join(root, "main.js"), `globalThis.example = ${JSON.stringify(Array.from({ length: 500 }, (_, id) => ({ id, label: `example-${id}` })))};`);
      const result = await build({
        configFile: false, root, base: "./", logLevel: "silent", plugins: [fixtureAssets, precompressAssets()],
        build: { write: false }
      });
      if (Array.isArray(result) || !("output" in result)) throw new Error("Expected one output bundle");
      const output = new Map(result.output.map((item) => [item.fileName, item]));
      const bytes = (fileName: string): Buffer => {
        const item = output.get(fileName);
        if (!item) throw new Error(`Missing output: ${fileName}`);
        const source = item.type === "chunk" ? item.code : item.source;
        return typeof source === "string" ? Buffer.from(source) : Buffer.from(source);
      };
      const chunk = result.output.find((item) => item.type === "chunk");
      expect(chunk).toBeDefined();
      for (const name of [chunk!.fileName, "assets/theme.css", "assets/formatter.wasm", "assets/pdf.worker.min.mjs"]) {
        const original = bytes(name);
        expect(gunzipSync(bytes(`${name}.gz`))).toEqual(original);
        expect(brotliDecompressSync(bytes(`${name}.br`))).toEqual(original);
        expect(bytes(`${name}.gz`).length).toBeLessThanOrEqual(original.length * 0.9);
        expect(bytes(`${name}.br`).length).toBeLessThanOrEqual(original.length * 0.9);
      }
      for (const name of Object.keys(fixtures).filter((name) => !["assets/theme.css", "assets/formatter.wasm", "assets/pdf.worker.min.mjs"].includes(name)).concat("index.html")) {
        expect(output.has(name), name).toBe(true);
        expect(output.has(`${name}.gz`), name).toBe(false);
        expect(output.has(`${name}.br`), name).toBe(false);
      }
      expect([...output.keys()].some((name) => /\.(?:gz|br)\.(?:gz|br)$/.test(name))).toBe(false);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});
