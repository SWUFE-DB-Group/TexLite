import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { Config } from "../src/server/config.js";
import {
  CompileQueue,
  ProjectCompileCoordinator,
  captureCompileSnapshot,
  publishCompileArtifacts,
  publishedCompileArtifacts,
  type CoordinatedCompileJob,
  type CoordinatedCompileResult
} from "../src/server/compiler.js";

describe("reliable project compilation", () => {
  const temporaryRoots: string[] = [];

  afterEach(() => {
    for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  it("reuses identical work and keeps only the latest pending revision per project", async () => {
    const coordinator = new ProjectCompileCoordinator(new CompileQueue(3));
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const events: string[] = [];
    let executions = 0;
    let activeForProject = 0;
    let maximumActiveForProject = 0;

    const job = (runId: string, revision: string, gate?: Promise<void>): CoordinatedCompileJob => ({
      projectId: "project-a", runId, revision,
      onQueued: () => events.push(`queued:${runId}`),
      onSelected: () => events.push(`selected:${runId}`),
      onDiscarded: (reason) => events.push(`${reason}:${runId}`),
      execute: async (): Promise<CoordinatedCompileResult> => {
        executions += 1;
        activeForProject += 1;
        maximumActiveForProject = Math.max(maximumActiveForProject, activeForProject);
        await gate;
        activeForProject -= 1;
        return { runId, revision, ok: true, log: runId, pdfPath: `${runId}.pdf`, synctexPath: null };
      }
    });

    const first = coordinator.request(job("run-1", "revision-1", firstGate));
    const duplicate = coordinator.request(job("run-1-duplicate", "revision-1"));
    expect(duplicate).toBe(first);
    const superseded = coordinator.request(job("run-2", "revision-2"));
    const latest = coordinator.request(job("run-3", "revision-3"));
    expect(executions).toBe(1);
    releaseFirst();

    await expect(first).resolves.toMatchObject({ runId: "run-1" });
    await expect(superseded).resolves.toMatchObject({ runId: "run-3" });
    await expect(latest).resolves.toMatchObject({ runId: "run-3" });
    expect(executions).toBe(2);
    expect(maximumActiveForProject).toBe(1);
    expect(events).toContain("duplicate:run-1-duplicate");
    expect(events).toContain("superseded:run-2");
  });

  it("compiles from an immutable snapshot and atomically selects a complete artifact set", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "texlite-compiler-"));
    temporaryRoots.push(root);
    const config = testConfig(root);
    const projectId = randomUUID();
    const liveSource = path.join(config.projectsDir, projectId, "source");
    fs.mkdirSync(liveSource, { recursive: true });
    fs.writeFileSync(path.join(liveSource, "main.tex"), "first revision\n");

    const first = captureCompileSnapshot(config, projectId, randomUUID(), {
      mainFile: "main.tex", engine: "pdflatex", latexmkrc: null, extraArgs: []
    });
    fs.writeFileSync(path.join(liveSource, "main.tex"), "second revision\n");
    expect(fs.readFileSync(path.join(first.sourceDir, "main.tex"), "utf8")).toBe("first revision\n");
    const firstPdf = path.join(first.outputDir, "main.pdf");
    const firstSync = path.join(first.outputDir, "main.synctex.gz");
    fs.writeFileSync(firstPdf, "first pdf");
    fs.writeFileSync(firstSync, "first sync");
    publishCompileArtifacts(config, projectId, first, {
      ok: true, log: "", pdfPath: firstPdf, synctexPath: firstSync
    });
    expect(publishedCompileArtifacts(config, projectId)).toMatchObject({
      runId: first.runId, revision: first.revision, source: first.sourceDir, pdf: firstPdf, synctex: firstSync
    });

    const second = captureCompileSnapshot(config, projectId, randomUUID(), {
      mainFile: "main.tex", engine: "pdflatex", latexmkrc: null, extraArgs: []
    });
    expect(second.revision).not.toBe(first.revision);
    const secondPdf = path.join(second.outputDir, "main.pdf");
    fs.writeFileSync(secondPdf, "second pdf");
    publishCompileArtifacts(config, projectId, second, {
      ok: true, log: "", pdfPath: secondPdf, synctexPath: null
    });
    expect(publishedCompileArtifacts(config, projectId)).toMatchObject({ runId: second.runId, pdf: secondPdf, synctex: null });
    expect(fs.existsSync(first.root)).toBe(true);
  });
});

function testConfig(root: string): Config {
  return {
    configPath: path.join(root, "config.json"), siteName: "Test", adminEmail: "admin@example.test",
    host: "127.0.0.1", port: 3000, dataDir: root, databasePath: path.join(root, "texlite.db"),
    projectsDir: path.join(root, "projects"), clientDir: path.join(root, "client"), sessionDays: 1,
    compileTimeoutMs: 30_000, maxCompileJobs: 3, latexmk: "latexmk", defaultEngine: "pdflatex",
    allowedEngines: ["pdflatex", "xelatex", "lualatex"], extraArgs: [], allowProjectLatexmkrc: true,
    maxUploadBytes: 50 * 1024 * 1024
  };
}
