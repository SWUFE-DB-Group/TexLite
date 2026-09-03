import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Config } from "../src/server/config.js";
import { LatexCompletionService } from "../src/server/latexCompletion.js";

const roots: string[] = [];

describe("LaTeX completion cache", () => {
  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  it("bounds per-file symbol caches together with completion results", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "texlite-completions-"));
    roots.push(root);
    const service = new LatexCompletionService(completionConfig(root));

    for (let index = 0; index < 65; index += 1) {
      const projectId = `project-${index}`;
      const source = path.join(root, "projects", projectId, "source");
      fs.mkdirSync(source, { recursive: true });
      fs.writeFileSync(path.join(source, "main.tex"), `\\newcommand{\\project${index}}{value}\n`);
      await service.build(projectId);
    }

    expect(service.stats()).toEqual({
      cachedProjects: 64,
      cachedSymbolProjects: 64,
      cachedFiles: 64,
      pending: 0
    });

    service.invalidate("project-64");
    expect(service.stats()).toEqual({
      cachedProjects: 63,
      cachedSymbolProjects: 63,
      cachedFiles: 63,
      pending: 0
    });
  });
});

function completionConfig(root: string): Config {
  return {
    configPath: path.join(root, "config.json"), siteName: "TexLite", adminEmail: "", host: "127.0.0.1", port: 3000,
    dataDir: root, databasePath: path.join(root, "texlite.db"), projectsDir: path.join(root, "projects"),
    clientDir: path.join(root, "client"), sessionDays: 1, compileTimeoutMs: 30_000, maxCompileJobs: 1,
    latexmk: "latexmk", defaultEngine: "pdflatex", allowedEngines: ["pdflatex", "xelatex", "lualatex"], extraArgs: [],
    allowProjectLatexmkrc: true, maxUploadBytes: 50 * 1024 * 1024,
    pdfLoadingStrategy: "auto", pdfRangeThresholdBytes: 5 * 1024 * 1024, historyMaxVersions: 200,
    historyMaxStorageBytes: 512 * 1024 * 1024, git: "git", gitOperationTimeoutMs: 30_000, githubApiBaseUrl: "https://api.github.com"
  };
}
