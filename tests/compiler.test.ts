import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { randomUUID } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import type { Config } from "../src/server/config.js";
import { openDatabase } from "../src/server/db.js";
import {
  CompileQueue,
  ProjectCompileCoordinator,
  captureCompileSnapshot,
  cleanCompileArtifacts,
  cleanCompileCache,
  compileProject,
  hasCompileCache,
  publishCompileArtifacts,
  publishedCompileArtifacts,
  pruneOrphanedCompileRuns,
  reconcilePublishedCompileRuns,
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
        return { runId, revision, ok: true, log: runId, diagnostics: { warnings: [], errors: [] }, pdfPath: `${runId}.pdf`, synctexPath: null };
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

  it("coalesces a generation before each job can create its snapshot", async () => {
    const coordinator = new ProjectCompileCoordinator(new CompileQueue(2));
    let snapshotCreations = 0;
    const job = (runId: string, resultRevision: string): CoordinatedCompileJob => ({
      projectId: "project-a", target: "main.tex", runId,
      generation: "source-generation-7", revision: resultRevision,
      onQueued: () => undefined,
      onSelected: () => undefined,
      onDiscarded: () => undefined,
      execute: async (): Promise<CoordinatedCompileResult> => {
        snapshotCreations += 1;
        return {
          runId,
          revision: resultRevision,
          ok: true,
          log: "",
          diagnostics: { warnings: [], errors: [] },
          pdfPath: `${runId}.pdf`,
          synctexPath: null
        };
      }
    });

    const first = coordinator.request(job("run-1", "content-digest-1"));
    const duplicate = coordinator.request(job("run-2", "content-digest-2"));
    expect(duplicate).toBe(first);
    await expect(duplicate).resolves.toMatchObject({ runId: "run-1", revision: "content-digest-1" });
    expect(snapshotCreations).toBe(1);
  });

  it("cancels a queued target without allowing it to create a snapshot", async () => {
    const queue = new CompileQueue(1);
    const coordinator = new ProjectCompileCoordinator(queue);
    let releaseBlocker!: () => void;
    const blocker = new Promise<void>((resolve) => { releaseBlocker = resolve; });
    void queue.add(async () => { await blocker; });
    let executions = 0;
    let cancelled = 0;
    const result = coordinator.request({
      projectId: "project-a", target: "main.tex", runId: "run-cancelled", revision: "revision-cancelled",
      onQueued: () => undefined,
      onSelected: () => undefined,
      onDiscarded: () => undefined,
      onCancelled: () => { cancelled += 1; },
      execute: async () => {
        executions += 1;
        return {
          runId: "run-cancelled", revision: "revision-cancelled", ok: true, log: "",
          diagnostics: { warnings: [], errors: [] }, pdfPath: "run-cancelled.pdf", synctexPath: null
        };
      }
    });

    expect(coordinator.cancel("project-a", "main.tex")).toEqual({ runId: "run-cancelled", status: "queued" });
    await expect(result).resolves.toMatchObject({ ok: false, cancelled: true, runId: "run-cancelled" });
    expect(executions).toBe(0);
    expect(cancelled).toBe(1);
    releaseBlocker();
  });

  it("compiles from an immutable snapshot and atomically selects a complete artifact set", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "texlite-compiler-"));
    temporaryRoots.push(root);
    const config = testConfig(root);
    const projectId = randomUUID();
    const liveSource = path.join(config.projectsDir, projectId, "source");
    fs.mkdirSync(liveSource, { recursive: true });
    fs.writeFileSync(path.join(liveSource, "main.tex"), "first revision\n");

    const first = await captureCompileSnapshot(config, projectId, randomUUID(), {
      mainFile: "main.tex", engine: "pdflatex", latexmkrc: null, extraArgs: [], generation: "generation-1"
    });
    fs.writeFileSync(path.join(liveSource, "main.tex"), "second revision\n");
    expect(fs.readFileSync(path.join(first.sourceDir, "main.tex"), "utf8")).toBe("first revision\n");
    const firstPdf = path.join(first.outputDir, "main.pdf");
    const firstSync = path.join(first.outputDir, "main.synctex.gz");
    fs.writeFileSync(firstPdf, "first pdf");
    fs.writeFileSync(firstSync, "first sync");
    publishCompileArtifacts(config, projectId, first, {
      ok: true, log: "", diagnostics: { warnings: [], errors: [] }, pdfPath: firstPdf, synctexPath: firstSync
    });
    expect(publishedCompileArtifacts(config, projectId)).toMatchObject({
      runId: first.runId, revision: first.revision, generation: "generation-1", source: first.sourceDir, pdf: firstPdf, synctex: firstSync
    });

    const second = await captureCompileSnapshot(config, projectId, randomUUID(), {
      mainFile: "main.tex", engine: "pdflatex", latexmkrc: null, extraArgs: [], generation: "generation-2"
    });
    expect(second.revision).not.toBe(first.revision);
    const secondPdf = path.join(second.outputDir, "main.pdf");
    fs.writeFileSync(secondPdf, "second pdf");
    publishCompileArtifacts(config, projectId, second, {
      ok: true, log: "", diagnostics: { warnings: [], errors: [] }, pdfPath: secondPdf, synctexPath: null
    });
    expect(publishedCompileArtifacts(config, projectId)).toMatchObject({ runId: second.runId, pdf: secondPdf, synctex: null });
    fs.writeFileSync(path.join(liveSource, "appendix.tex"), "appendix revision\n");
    const appendix = await captureCompileSnapshot(config, projectId, randomUUID(), {
      mainFile: "appendix.tex", engine: "pdflatex", latexmkrc: null, extraArgs: []
    });
    const appendixPdf = path.join(appendix.outputDir, "appendix.pdf");
    fs.writeFileSync(appendixPdf, "appendix pdf");
    publishCompileArtifacts(config, projectId, appendix, {
      ok: true, log: "", diagnostics: { warnings: [], errors: [] }, pdfPath: appendixPdf, synctexPath: null
    });
    expect(publishedCompileArtifacts(config, projectId, "main.tex")).toMatchObject({ runId: second.runId, mainFile: "main.tex" });
    expect(publishedCompileArtifacts(config, projectId, "appendix.tex")).toMatchObject({ runId: appendix.runId, mainFile: "appendix.tex" });
    expect(fs.existsSync(first.root)).toBe(true);
    pruneOrphanedCompileRuns(config, projectId);
    expect(fs.existsSync(first.root)).toBe(false);
    expect(fs.existsSync(second.root)).toBe(true);
    expect(fs.existsSync(appendix.root)).toBe(true);
  });

  it("reuses a stable latexmk work directory and isolates caches by compile target", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "texlite-compiler-cache-"));
    temporaryRoots.push(root);
    const config = testConfig(root);
    const fakeLatexmk = path.join(root, "fake-latexmk.mjs");
    fs.writeFileSync(fakeLatexmk, `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";
const outputArgument = process.argv.find((argument) => argument.startsWith("-outdir="));
const output = outputArgument.slice("-outdir=".length);
const main = process.argv.at(-1);
const basename = path.basename(main, ".tex");
fs.mkdirSync(output, { recursive: true });
const counterPath = path.join(output, ".fake-invocations");
const count = fs.existsSync(counterPath) ? Number(fs.readFileSync(counterPath, "utf8")) + 1 : 1;
const source = fs.readFileSync(path.resolve(main), "utf8");
fs.writeFileSync(counterPath, String(count));
fs.writeFileSync(path.join(output, basename + ".pdf"), "%PDF-1.4\\n" + count + "\\n" + source);
fs.writeFileSync(path.join(output, basename + ".synctex.gz"), gzipSync("SyncTeX Version:1\\nInput:1:" + path.resolve(main) + "\\n"));
console.log(JSON.stringify({ count, cwd: process.cwd() }));
`);
    fs.chmodSync(fakeLatexmk, 0o700);
    config.latexmk = fakeLatexmk;
    const projectId = randomUUID();
    const liveSource = path.join(config.projectsDir, projectId, "source");
    fs.mkdirSync(liveSource, { recursive: true });
    fs.writeFileSync(path.join(liveSource, "main.tex"), "first revision\n");

    const first = await captureCompileSnapshot(config, projectId, randomUUID(), {
      mainFile: "main.tex", engine: "pdflatex", latexmkrc: null, extraArgs: []
    });
    const firstResult = await compileProject(config, first, "main.tex", "pdflatex", null);
    expect(firstResult.ok, firstResult.log).toBe(true);
    expect(fs.readFileSync(firstResult.pdfPath!, "utf8")).toContain("1\nfirst revision");
    expect(gunzipSync(fs.readFileSync(firstResult.synctexPath!)).toString("utf8")).toContain(first.sourceDir);

    fs.writeFileSync(path.join(liveSource, "main.tex"), "second revision\n");
    const second = await captureCompileSnapshot(config, projectId, randomUUID(), {
      mainFile: "main.tex", engine: "pdflatex", latexmkrc: null, extraArgs: []
    });
    const secondResult = await compileProject(config, second, "main.tex", "pdflatex", null);
    expect(secondResult.ok, secondResult.log).toBe(true);
    expect(fs.readFileSync(path.join(first.outputDir, ".fake-invocations"), "utf8")).toBe("1");
    expect(fs.readFileSync(path.join(second.outputDir, ".fake-invocations"), "utf8")).toBe("2");
    expect(fs.readFileSync(firstResult.pdfPath!, "utf8")).toContain("1\nfirst revision");
    expect(fs.readFileSync(secondResult.pdfPath!, "utf8")).toContain("2\nsecond revision");
    expect(gunzipSync(fs.readFileSync(secondResult.synctexPath!)).toString("utf8")).toContain(second.sourceDir);
    expect(secondResult.timings).toMatchObject({ cacheSyncMs: expect.any(Number), latexmkMs: expect.any(Number) });
    const cacheDirectory = path.join(config.projectsDir, projectId, "output", ".texlite", "cache");
    expect(fs.readdirSync(cacheDirectory)).toHaveLength(1);
    const mainCacheDirectory = path.join(cacheDirectory, fs.readdirSync(cacheDirectory)[0]);
    expect(fs.readdirSync(mainCacheDirectory)).toHaveLength(1);

    const differentEngine = await captureCompileSnapshot(config, projectId, randomUUID(), {
      mainFile: "main.tex", engine: "xelatex", latexmkrc: null, extraArgs: []
    });
    const differentEngineResult = await compileProject(config, differentEngine, "main.tex", "xelatex", null);
    expect(differentEngineResult.ok, differentEngineResult.log).toBe(true);
    expect(fs.readFileSync(path.join(differentEngine.outputDir, ".fake-invocations"), "utf8")).toBe("1");
    expect(fs.readFileSync(secondResult.pdfPath!, "utf8")).toContain("2\nsecond revision");
    expect(fs.readdirSync(cacheDirectory)).toHaveLength(1);
    expect(fs.readdirSync(mainCacheDirectory)).toHaveLength(1);

    fs.writeFileSync(path.join(liveSource, "appendix.tex"), "appendix revision\n");
    const appendix = await captureCompileSnapshot(config, projectId, randomUUID(), {
      mainFile: "appendix.tex", engine: "pdflatex", latexmkrc: null, extraArgs: []
    });
    const appendixResult = await compileProject(config, appendix, "appendix.tex", "pdflatex", null);
    expect(appendixResult.ok, appendixResult.log).toBe(true);
    expect(fs.readdirSync(cacheDirectory)).toHaveLength(2);
  });

  it("ignores ambient latexmkrc files unless the project setting selects one", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "texlite-compiler-rc-"));
    temporaryRoots.push(root);
    const config = testConfig(root);
    const fakeLatexmk = path.join(root, "fake-latexmk.mjs");
    const fakeScript = [
      "#!/usr/bin/env node",
      "import fs from \"node:fs\";",
      "import path from \"node:path\";",
      "const output = process.argv.find((argument) => argument.startsWith(\"-outdir=\")).slice(\"-outdir=\".length);",
      "const main = process.argv.at(-1);",
      "const basename = path.basename(main, \".tex\");",
      "fs.mkdirSync(output, { recursive: true });",
      "fs.writeFileSync(path.join(output, \".args\"), JSON.stringify(process.argv.slice(2)));",
      "fs.writeFileSync(path.join(output, basename + \".pdf\"), \"%PDF-1.4\\n\");"
    ].join("\n");
    fs.writeFileSync(fakeLatexmk, fakeScript);
    fs.chmodSync(fakeLatexmk, 0o700);
    config.latexmk = fakeLatexmk;
    const projectId = randomUUID();
    const liveSource = path.join(config.projectsDir, projectId, "source");
    fs.mkdirSync(liveSource, { recursive: true });
    fs.writeFileSync(path.join(liveSource, "main.tex"), "\\documentclass{article}\\begin{document}x\\end{document}\\n");
    // This file is intentionally present in the source tree, as it would be
    // after importing a normal LaTeX archive.
    fs.writeFileSync(path.join(liveSource, ".latexmkrc"), "$silent = 1;\\n");

    const withoutConfiguredRc = await captureCompileSnapshot(config, projectId, randomUUID(), {
      mainFile: "main.tex", engine: "pdflatex", latexmkrc: null, extraArgs: []
    });
    const ignoredResult = await compileProject(config, withoutConfiguredRc, "main.tex", "pdflatex", null);
    expect(ignoredResult.ok, ignoredResult.log).toBe(true);
    const ignoredArgs = JSON.parse(fs.readFileSync(path.join(withoutConfiguredRc.outputDir, ".args"), "utf8")) as string[];
    expect(ignoredArgs).toContain("-norc");
    expect(ignoredArgs).not.toContain("-r");

    const withConfiguredRc = await captureCompileSnapshot(config, projectId, randomUUID(), {
      mainFile: "main.tex", engine: "pdflatex", latexmkrc: ".latexmkrc", extraArgs: []
    });
    const configuredResult = await compileProject(config, withConfiguredRc, "main.tex", "pdflatex", ".latexmkrc");
    expect(configuredResult.ok, configuredResult.log).toBe(true);
    const configuredArgs = JSON.parse(fs.readFileSync(path.join(withConfiguredRc.outputDir, ".args"), "utf8")) as string[];
    expect(configuredArgs.filter((argument) => argument === "-norc")).toHaveLength(1);
    expect(configuredArgs.filter((argument) => argument === "-r")).toHaveLength(1);
    expect(configuredArgs).toContain(".latexmkrc");
  });

  it("coordinates different root documents independently", async () => {
    const coordinator = new ProjectCompileCoordinator(new CompileQueue(2));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const active = new Set<string>();
    let overlapped = false;
    const job = (target: string): CoordinatedCompileJob => ({
      projectId: "project-a", target, runId: target, revision: `revision:${target}`,
      onQueued: () => undefined,
      onSelected: () => undefined,
      onDiscarded: () => undefined,
      execute: async () => {
        active.add(target);
        if (active.size === 2) overlapped = true;
        await gate;
        active.delete(target);
        return { runId: target, revision: `revision:${target}`, ok: true, log: "", diagnostics: { warnings: [], errors: [] }, pdfPath: `${target}.pdf`, synctexPath: null };
      }
    });
    const main = coordinator.request(job("main.tex"));
    const appendix = coordinator.request(job("appendix.tex"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(overlapped).toBe(true);
    release();
    await expect(Promise.all([main, appendix])).resolves.toHaveLength(2);
  });

  it("cleans the incremental cache separately from published artifacts", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "texlite-compiler-clean-"));
    temporaryRoots.push(root);
    const config = testConfig(root);
    const projectId = randomUUID();
    const liveSource = path.join(config.projectsDir, projectId, "source");
    fs.mkdirSync(liveSource, { recursive: true });
    fs.writeFileSync(path.join(liveSource, "main.tex"), "source\n");
    const snapshot = await captureCompileSnapshot(config, projectId, randomUUID(), {
      mainFile: "main.tex", engine: "pdflatex", latexmkrc: null, extraArgs: []
    });
    const pdf = path.join(snapshot.outputDir, "main.pdf");
    fs.writeFileSync(pdf, "%PDF-1.4\n");
    publishCompileArtifacts(config, projectId, snapshot, {
      ok: true, log: "", diagnostics: { warnings: [], errors: [] }, pdfPath: pdf, synctexPath: null
    });
    const cacheRoot = path.join(config.projectsDir, projectId, "output", ".texlite", "cache");
    const targetKey = createHash("sha256").update("main.tex").digest("hex").slice(0, 24);
    fs.mkdirSync(path.join(cacheRoot, targetKey, "settings"), { recursive: true });
    expect(hasCompileCache(config, projectId, "main.tex")).toBe(true);
    cleanCompileCache(config, projectId, "main.tex");
    expect(hasCompileCache(config, projectId, "main.tex")).toBe(false);
    expect(publishedCompileArtifacts(config, projectId, "main.tex")).toMatchObject({ runId: snapshot.runId });
    cleanCompileArtifacts(config, projectId, "main.tex", "main.tex", [snapshot.runId]);
    expect(publishedCompileArtifacts(config, projectId, "main.tex")).toBeNull();
    expect(fs.existsSync(snapshot.root)).toBe(false);
  });

  it("reconciles a published PDF whose database run was interrupted", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "texlite-compiler-recovery-"));
    temporaryRoots.push(root);
    const config = testConfig(root);
    const db = openDatabase(config);
    const projectId = randomUUID();
    const ownerId = randomUUID();
    const createdAt = new Date().toISOString();
    db.prepare(`INSERT INTO users
      (id, username, display_name, password_hash, role, disabled, must_change_password, can_create_projects, created_at)
      VALUES (?, 'owner', 'Owner', 'hash', 'user', 0, 0, 1, ?)`)
      .run(ownerId, createdAt);
    db.prepare(`INSERT INTO projects
      (id, owner_id, last_modified_by, name, main_file, latexmkrc, engine, created_at, updated_at)
      VALUES (?, ?, ?, 'Recovery', 'main.tex', NULL, 'pdflatex', ?, ?)`)
      .run(projectId, ownerId, ownerId, createdAt, createdAt);
    const liveSource = path.join(config.projectsDir, projectId, "source");
    fs.mkdirSync(liveSource, { recursive: true });
    fs.writeFileSync(path.join(liveSource, "main.tex"), "source\n");
    const snapshot = await captureCompileSnapshot(config, projectId, randomUUID(), {
      mainFile: "main.tex", engine: "pdflatex", latexmkrc: null, extraArgs: []
    });
    const pdf = path.join(snapshot.outputDir, "main.pdf");
    fs.writeFileSync(pdf, "%PDF-1.4\n");
    publishCompileArtifacts(config, projectId, snapshot, {
      ok: true, log: "successful compile", diagnostics: { warnings: [], errors: [] }, pdfPath: pdf, synctexPath: null
    });
    db.prepare(`INSERT INTO compile_runs
      (id, project_id, requested_by, main_file, status, log, created_at)
      VALUES (?, ?, ?, 'main.tex', 'running', '', ?)`)
      .run(snapshot.runId, projectId, ownerId, createdAt);

    reconcilePublishedCompileRuns(config, db, projectId);
    expect(db.prepare("SELECT status, finished_at, log FROM compile_runs WHERE id = ?").get(snapshot.runId)).toMatchObject({
      status: "succeeded", finished_at: expect.any(String), log: "Recovered a published PDF after a server restart."
    });
    db.close();
  });
});

function testConfig(root: string): Config {
  return {
    configPath: path.join(root, "config.json"), siteName: "Test", adminEmail: "admin@example.test",
    host: "127.0.0.1", port: 3000, dataDir: root, databasePath: path.join(root, "texlite.db"),
    projectsDir: path.join(root, "projects"), clientDir: path.join(root, "client"), sessionDays: 1,
    compileTimeoutMs: 30_000, maxCompileJobs: 3, latexmk: "latexmk", defaultEngine: "pdflatex",
    allowedEngines: ["pdflatex", "xelatex", "lualatex"], extraArgs: [], allowProjectLatexmkrc: true,
    maxUploadBytes: 50 * 1024 * 1024, pdfLoadingStrategy: "auto", pdfRangeThresholdBytes: 5 * 1024 * 1024,
    historyMaxVersions: 200, historyMaxStorageBytes: 512 * 1024 * 1024,
    git: "git", gitOperationTimeoutMs: 30_000, githubApiBaseUrl: "https://api.github.com"
  };
}
