import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Config } from "../src/server/config.js";
import { ProjectOutlineService } from "../src/server/projectOutline.js";

const roots: string[] = [];

describe("project outline service", () => {
  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  it("coalesces and invalidates cached outlines by project tree metadata", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "texlite-outline-"));
    roots.push(root);
    const projectId = "project-outline";
    const source = path.join(root, "projects", projectId, "source");
    fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(path.join(source, "main.tex"), "\\documentclass{article}\n\\input{sections/tex}\n");
    fs.mkdirSync(path.join(source, "sections"));
    fs.writeFileSync(path.join(source, "sections", "tex.tex"), "\\section{First}\n");
    const config = outlineConfig(root);
    const service = new ProjectOutlineService(config);

    const first = await service.build(projectId, "main.tex");
    expect(first).toEqual([expect.objectContaining({ path: "sections/tex.tex", title: "First" })]);
    expect(service.stats()).toMatchObject({ cachedOutlines: 1, pending: 0 });
    await expect(service.build(projectId, "main.tex")).resolves.toEqual(first);
    expect(service.stats()).toMatchObject({ cachedOutlines: 1, pending: 0 });

    fs.writeFileSync(path.join(source, "sections", "tex.tex"), "\\section{Updated}\n");
    const updated = await service.build(projectId, "main.tex");
    expect(updated).toEqual([expect.objectContaining({ path: "sections/tex.tex", title: "Updated" })]);
  });
});

function outlineConfig(root: string): Config {
  return {
    configPath: path.join(root, "config.json"), siteName: "TexLite", adminEmail: "", host: "127.0.0.1", port: 3000,
    dataDir: root, databasePath: path.join(root, "texlite.db"), projectsDir: path.join(root, "projects"),
    clientDir: path.join(root, "client"), sessionDays: 1, compileTimeoutMs: 30_000, maxCompileJobs: 1,
    latexmk: "latexmk", defaultEngine: "pdflatex", allowedEngines: ["pdflatex", "xelatex", "lualatex"], extraArgs: [],
    allowProjectLatexmkrc: true, maxUploadBytes: 50 * 1024 * 1024, historyMaxVersions: 200,
    historyMaxStorageBytes: 512 * 1024 * 1024, git: "git", gitOperationTimeoutMs: 30_000, githubApiBaseUrl: "https://api.github.com"
  };
}
