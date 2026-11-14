import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectTemplateCache } from "../src/server/projectTemplateCache.js";
import { downloadProjectTemplate } from "../src/server/projectTemplateDownload.js";

vi.mock("../src/server/projectTemplateDownload.js", async (original) => ({ ...await original<typeof import("../src/server/projectTemplateDownload.js")>(), downloadProjectTemplate: vi.fn() }));
let directory: string, now: number;
const url = "https://example.org/template.zip?version=1";
const archive = Buffer.from("validated archive");
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "texlite-template-cache-"));
  now = Date.now(); vi.spyOn(Date, "now").mockImplementation(() => now);
  vi.mocked(downloadProjectTemplate).mockReset().mockResolvedValue(archive);
});
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(directory, { recursive: true, force: true }); });

describe("template ZIP cache", () => {
  it("reuses validated downloads across service restarts but does not cache an unvalidated download", async () => {
    const cache = new ProjectTemplateCache(directory, 1024);
    fs.writeFileSync(path.join(directory, "f".repeat(64) + ".zip"), "orphaned archive");
    await cache.download(url); await cache.download(url);
    expect(fs.readdirSync(directory)).toEqual([]);
    expect(downloadProjectTemplate).toHaveBeenCalledTimes(2);
    await cache.store(url, archive);
    expect(await new ProjectTemplateCache(directory, 1024).download(url + "#ignored")).toEqual({ archive, cached: true });
    expect(downloadProjectTemplate).toHaveBeenCalledTimes(2);
    expect(fs.readdirSync(directory).every((file) => /^[a-f0-9]{64}\.(?:zip|json)$/.test(file))).toBe(true);
  });

  it("expires after seven days without extending lifetime on reads, and removes other expired cache files on use", async () => {
    const cache = new ProjectTemplateCache(directory, 1024);
    await cache.store(url, archive); await cache.store("https://other.example.org/file", archive);
    now += 6 * 24 * 60 * 60_000;
    expect(await cache.download(url)).toEqual({ archive, cached: true }); expect(downloadProjectTemplate).not.toHaveBeenCalled();
    now += 24 * 60 * 60_000 + 1;
    vi.mocked(downloadProjectTemplate).mockResolvedValueOnce(Buffer.from("updated archive"));
    expect(await cache.download(url)).toEqual({ archive: Buffer.from("updated archive"), cached: false });
    expect(downloadProjectTemplate).toHaveBeenCalledOnce();
    expect(fs.readdirSync(directory)).toEqual([]);
  });

  it("does not reuse corrupted bytes or entries above a lowered limit, and separates query strings", async () => {
    const cache = new ProjectTemplateCache(directory, 1024);
    await cache.store(url, archive);
    const file = fs.readdirSync(directory).find((name) => name.endsWith(".zip"))!;
    fs.writeFileSync(path.join(directory, file), Buffer.alloc(archive.length));
    expect(await cache.download(url)).toEqual({ archive, cached: false });
    expect(downloadProjectTemplate).toHaveBeenCalledTimes(1);
    await cache.store(url, archive);
    await new ProjectTemplateCache(directory, 1).download(url);
    await cache.download("https://example.org/template.zip?version=2");
    expect(downloadProjectTemplate).toHaveBeenCalledTimes(3);
  });
});
