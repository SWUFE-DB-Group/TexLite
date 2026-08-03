import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import { gunzipSync, gzipSync } from "node:zlib";
import type { Config } from "./config.js";
import { listProjectFiles, outputRoot, safeRelativePath, sourceRoot } from "./files.js";

export interface CompileTimings {
  cacheSyncMs: number;
  latexmkMs: number;
  artifactCopyMs: number;
  publishMs?: number;
  totalMs: number;
}

export interface CompileResult {
  ok: boolean;
  log: string;
  pdfPath: string | null;
  synctexPath: string | null;
  timings?: CompileTimings;
}

interface CompileSnapshotFile {
  path: string;
  digest: string;
  size: number;
  mtimeMs: number;
}

export interface CompileSnapshot {
  projectId: string;
  runId: string;
  revision: string;
  root: string;
  sourceDir: string;
  outputDir: string;
  files: CompileSnapshotFile[];
  directories: string[];
}

export interface PublishedCompileArtifacts {
  runId: string;
  revision: string;
  source: string;
  output: string;
  pdf: string;
  synctex: string | null;
}

export interface CoordinatedCompileResult extends CompileResult {
  runId: string;
  revision: string;
}

export interface CoordinatedCompileJob {
  projectId: string;
  runId: string;
  revision: string;
  onQueued: () => void;
  onSelected: () => void;
  onDiscarded: (reason: "duplicate" | "superseded") => void;
  execute: () => Promise<CoordinatedCompileResult>;
}

type Task = () => Promise<void>;

export class CompileQueue {
  private running = 0;
  private readonly pending: Task[] = [];

  constructor(private readonly concurrency: number) {}

  add<T>(job: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.pending.push(async () => {
        try {
          resolve(await job());
        } catch (error) {
          reject(error);
        }
      });
      this.drain();
    });
  }

  private drain(): void {
    while (this.running < this.concurrency && this.pending.length > 0) {
      const task = this.pending.shift();
      if (!task) return;
      this.running += 1;
      void task().finally(() => {
        this.running -= 1;
        this.drain();
      });
    }
  }
}

interface ManagedCompileJob {
  input: CoordinatedCompileJob;
  promise: Promise<CoordinatedCompileResult>;
  resolve: (result: CoordinatedCompileResult) => void;
  reject: (error: unknown) => void;
}

interface ProjectCompileState {
  active: ManagedCompileJob | null;
  pending: ManagedCompileJob | null;
}

/** Serializes each project while still respecting the server-wide LaTeX process limit. */
export class ProjectCompileCoordinator {
  private readonly projects = new Map<string, ProjectCompileState>();

  constructor(private readonly queue: CompileQueue) {}

  request(input: CoordinatedCompileJob): Promise<CoordinatedCompileResult> {
    const state = this.projects.get(input.projectId) ?? { active: null, pending: null };
    this.projects.set(input.projectId, state);

    if (state.active?.input.revision === input.revision) {
      if (state.pending) {
        this.redirect(state.pending, state.active);
        state.pending.input.onDiscarded("superseded");
        state.pending = null;
      }
      input.onDiscarded("duplicate");
      state.active.input.onSelected();
      return state.active.promise;
    }
    if (state.pending?.input.revision === input.revision) {
      input.onDiscarded("duplicate");
      return state.pending.promise;
    }

    const managed = deferredJob(input);
    if (state.active) {
      if (state.pending) {
        this.redirect(state.pending, managed);
        state.pending.input.onDiscarded("superseded");
      }
      state.pending = managed;
    } else {
      state.active = managed;
      input.onQueued();
      this.start(input.projectId, state, managed);
    }
    return managed.promise;
  }

  private start(projectId: string, state: ProjectCompileState, job: ManagedCompileJob): void {
    void this.queue.add(job.input.execute).then(job.resolve, job.reject).finally(() => {
      if (state.active !== job) return;
      state.active = null;
      const next = state.pending;
      state.pending = null;
      if (next) {
        state.active = next;
        next.input.onQueued();
        this.start(projectId, state, next);
      } else {
        this.projects.delete(projectId);
      }
    });
  }

  private redirect(from: ManagedCompileJob, to: ManagedCompileJob): void {
    void to.promise.then(from.resolve, from.reject);
  }
}

function deferredJob(input: CoordinatedCompileJob): ManagedCompileJob {
  let resolve!: (result: CoordinatedCompileResult) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<CoordinatedCompileResult>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { input, promise, resolve, reject };
}

export function captureCompileSnapshot(
  config: Config,
  projectId: string,
  runId: string,
  settings: { mainFile: string; engine: string; latexmkrc: string | null; extraArgs: string[] }
): CompileSnapshot {
  const root = compileRunRoot(config, projectId, runId);
  const snapshotSource = path.join(root, "source");
  const snapshotOutput = path.join(root, "output");
  fs.mkdirSync(snapshotSource, { recursive: true, mode: 0o700 });
  fs.mkdirSync(snapshotOutput, { recursive: true, mode: 0o700 });
  const hash = createHash("sha256");
  const files: CompileSnapshotFile[] = [];
  const directories: string[] = [];
  hash.update(JSON.stringify(settings));
  try {
    for (const entry of listProjectFiles(config, projectId).sort((left, right) => left.path.localeCompare(right.path))) {
      const destination = path.join(snapshotSource, entry.path);
      hash.update(`\0${entry.type}\0${entry.path}\0`);
      if (entry.type === "directory") {
        fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
        directories.push(entry.path);
        continue;
      }
      const liveFile = path.join(sourceRoot(config, projectId), entry.path);
      const stat = fs.statSync(liveFile);
      const content = fs.readFileSync(liveFile);
      hash.update(content);
      fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
      fs.writeFileSync(destination, content, { mode: 0o600 });
      fs.utimesSync(destination, stat.atime, stat.mtime);
      files.push({
        path: entry.path,
        digest: createHash("sha256").update(content).digest("hex"),
        size: content.length,
        mtimeMs: stat.mtimeMs
      });
    }
    return {
      projectId, runId, revision: hash.digest("hex"), root,
      sourceDir: snapshotSource, outputDir: snapshotOutput, files, directories
    };
  } catch (error) {
    fs.rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

export function discardCompileSnapshot(snapshot: CompileSnapshot): void {
  fs.rmSync(snapshot.root, { recursive: true, force: true });
}

export function publishCompileArtifacts(
  config: Config,
  projectId: string,
  snapshot: CompileSnapshot,
  result: CompileResult
): PublishedCompileArtifacts {
  if (!result.ok || !result.pdfPath) throw new Error("无法发布失败的编译结果");
  const manifestDirectory = compileDataRoot(config, projectId);
  const previous = publishedCompileArtifacts(config, projectId);
  const manifest = {
    version: 1,
    runId: snapshot.runId,
    revision: snapshot.revision,
    pdf: path.basename(result.pdfPath),
    synctex: result.synctexPath ? path.basename(result.synctexPath) : null
  };
  fs.mkdirSync(manifestDirectory, { recursive: true, mode: 0o700 });
  const target = path.join(manifestDirectory, "latest.json");
  const temporary = path.join(manifestDirectory, `latest-${snapshot.runId}.tmp`);
  fs.writeFileSync(temporary, JSON.stringify(manifest), { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, target);
  if (previous && previous.runId !== snapshot.runId) {
    // Keep the previous immutable bundle briefly so an already-open PDF or SyncTeX
    // request can finish after the manifest switches to the new bundle.
    const cleanup = setTimeout(() => {
      fs.rmSync(compileRunRoot(config, projectId, previous.runId), { recursive: true, force: true });
    }, 60_000);
    cleanup.unref();
  }
  return publishedCompileArtifacts(config, projectId)!;
}

export function publishedCompileArtifacts(config: Config, projectId: string): PublishedCompileArtifacts | null {
  const manifestPath = path.join(compileDataRoot(config, projectId), "latest.json");
  if (!fs.existsSync(manifestPath)) return null;
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
      version?: unknown; runId?: unknown; revision?: unknown; pdf?: unknown; synctex?: unknown;
    };
    if (manifest.version !== 1 || typeof manifest.runId !== "string" || !/^[a-f0-9-]{36}$/i.test(manifest.runId)
      || typeof manifest.revision !== "string" || typeof manifest.pdf !== "string"
      || path.basename(manifest.pdf) !== manifest.pdf
      || (manifest.synctex !== null && (typeof manifest.synctex !== "string" || path.basename(manifest.synctex) !== manifest.synctex))) {
      return null;
    }
    const root = compileRunRoot(config, projectId, manifest.runId);
    const source = path.join(root, "source");
    const output = path.join(root, "output");
    const pdf = path.join(output, manifest.pdf);
    const synctex = manifest.synctex ? path.join(output, manifest.synctex) : null;
    if (!fs.existsSync(source) || !fs.existsSync(output) || !fs.existsSync(pdf) || (synctex && !fs.existsSync(synctex))) return null;
    return { runId: manifest.runId, revision: manifest.revision, source, output, pdf, synctex };
  } catch {
    return null;
  }
}

function compileDataRoot(config: Config, projectId: string): string {
  return path.join(outputRoot(config, projectId), ".texlite");
}

function compileRunRoot(config: Config, projectId: string, runId: string): string {
  return path.join(compileDataRoot(config, projectId), "runs", runId);
}

interface CompileCacheFileState {
  digest: string;
  size: number;
  mtimeMs: number;
}

interface CompileCacheState {
  version: 1;
  files: Record<string, CompileCacheFileState>;
}

interface PreparedCompileCache {
  sourceDir: string;
  outputDir: string;
}

function compileCacheKey(
  config: Config,
  snapshot: CompileSnapshot,
  mainFile: string,
  engine: "pdflatex" | "xelatex" | "lualatex",
  latexmkrc: string | null
): string {
  const hash = createHash("sha256");
  hash.update(JSON.stringify({
    version: 1,
    latexmk: config.latexmk,
    engine,
    mainFile,
    latexmkrc,
    extraArgs: config.extraArgs
  }));
  if (latexmkrc) hash.update(fs.readFileSync(path.join(snapshot.sourceDir, latexmkrc)));
  return hash.digest("hex").slice(0, 24);
}

function prepareCompileCache(
  config: Config,
  snapshot: CompileSnapshot,
  mainFile: string,
  engine: "pdflatex" | "xelatex" | "lualatex",
  latexmkrc: string | null
): PreparedCompileCache {
  const cacheDirectory = path.join(compileDataRoot(config, snapshot.projectId), "cache");
  const key = compileCacheKey(config, snapshot, mainFile, engine, latexmkrc);
  const root = path.join(cacheDirectory, key);
  const cacheSource = path.join(root, "source");
  const cacheOutput = path.join(root, "output");
  const statePath = path.join(root, "state.json");
  fs.mkdirSync(cacheSource, { recursive: true, mode: 0o700 });
  fs.mkdirSync(cacheOutput, { recursive: true, mode: 0o700 });
  // A settings change intentionally starts cold. Published run bundles are
  // self-contained, so older mutable caches can be removed without affecting
  // the PDF currently visible to users.
  for (const entry of fs.readdirSync(cacheDirectory, { withFileTypes: true })) {
    if (entry.name !== key) fs.rmSync(path.join(cacheDirectory, entry.name), { recursive: true, force: true });
  }

  const previous = readCompileCacheState(statePath);
  const validFiles = new Set(snapshot.files.map((file) => file.path));
  const validDirectories = new Set(snapshot.directories);
  for (const file of snapshot.files) {
    for (let parent = path.posix.dirname(file.path); parent !== "."; parent = path.posix.dirname(parent)) {
      validDirectories.add(parent);
    }
  }
  pruneCompileSource(cacheSource, "", validFiles, validDirectories);

  const nextFiles: Record<string, CompileCacheFileState> = {};
  for (const directory of [...validDirectories].sort()) {
    fs.mkdirSync(path.join(cacheSource, directory), { recursive: true, mode: 0o700 });
  }
  for (const file of snapshot.files) {
    const source = path.join(snapshot.sourceDir, file.path);
    const destination = path.join(cacheSource, file.path);
    const previousFile = previous?.files[file.path];
    const destinationStat = regularFileStat(destination);
    if (!previousFile || previousFile.digest !== file.digest || previousFile.size !== file.size
      || !destinationStat || destinationStat.size !== file.size) {
      fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
      const temporary = `${destination}.texlite-${process.pid}-${Date.now()}`;
      try {
        fs.copyFileSync(source, temporary);
        fs.chmodSync(temporary, 0o600);
        // A changed file must be newer than both its cached predecessor and the
        // last generated output.  Unchanged files are never rewritten, so their
        // stable mtimes let latexmk reuse its dependency database.
        const mtimeMs = Math.max(file.mtimeMs, destinationStat ? destinationStat.mtimeMs + 1 : 0, Date.now());
        fs.utimesSync(temporary, new Date(mtimeMs), new Date(mtimeMs));
        fs.renameSync(temporary, destination);
      } finally {
        if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
      }
    }
    const cachedStat = fs.statSync(destination);
    nextFiles[file.path] = { digest: file.digest, size: file.size, mtimeMs: cachedStat.mtimeMs };
  }
  writeCompileCacheState(statePath, { version: 1, files: nextFiles });
  return { sourceDir: cacheSource, outputDir: cacheOutput };
}

function readCompileCacheState(statePath: string): CompileCacheState | null {
  if (!fs.existsSync(statePath)) return null;
  try {
    const state = JSON.parse(fs.readFileSync(statePath, "utf8")) as CompileCacheState;
    if (state.version !== 1 || typeof state.files !== "object" || state.files === null) return null;
    return state;
  } catch {
    return null;
  }
}

function writeCompileCacheState(statePath: string, state: CompileCacheState): void {
  const temporary = `${statePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(state), { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, statePath);
}

function regularFileStat(file: string): fs.Stats | null {
  try {
    const stat = fs.lstatSync(file);
    return stat.isFile() ? stat : null;
  } catch {
    return null;
  }
}

function pruneCompileSource(root: string, prefix: string, validFiles: Set<string>, validDirectories: Set<string>): void {
  for (const entry of fs.readdirSync(path.join(root, prefix), { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolute = path.join(root, relative);
    if (entry.isDirectory()) {
      if (!validDirectories.has(relative)) fs.rmSync(absolute, { recursive: true, force: true });
      else pruneCompileSource(root, relative, validFiles, validDirectories);
    } else if (!entry.isFile() || !validFiles.has(relative)) {
      fs.rmSync(absolute, { force: true });
    }
  }
}

function materializeCompileArtifacts(cache: PreparedCompileCache, snapshot: CompileSnapshot, basename: string): {
  pdfPath: string;
  synctexPath: string | null;
} {
  fs.rmSync(snapshot.outputDir, { recursive: true, force: true });
  fs.mkdirSync(snapshot.outputDir, { recursive: true, mode: 0o700 });
  copyCompileArtifacts(cache.outputDir, snapshot.outputDir);
  const pdfPath = path.join(snapshot.outputDir, `${basename}.pdf`);
  const synctexPath = path.join(snapshot.outputDir, `${basename}.synctex.gz`);
  if (fs.existsSync(synctexPath)) rewriteSynctexSource(synctexPath, cache.sourceDir, snapshot.sourceDir);
  return { pdfPath, synctexPath: fs.existsSync(synctexPath) ? synctexPath : null };
}

function copyCompileArtifacts(source: string, destination: string): void {
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(to, { recursive: true, mode: 0o700 });
      copyCompileArtifacts(from, to);
    } else if (entry.isFile()) {
      fs.copyFileSync(from, to);
      fs.chmodSync(to, 0o600);
    }
  }
}

function rewriteSynctexSource(synctexPath: string, cacheSource: string, snapshotSource: string): void {
  const original = gunzipSync(fs.readFileSync(synctexPath)).toString("utf8");
  const rewritten = original.replaceAll(path.resolve(cacheSource), path.resolve(snapshotSource));
  if (rewritten !== original) fs.writeFileSync(synctexPath, gzipSync(Buffer.from(rewritten)), { mode: 0o600 });
}

export async function compileProject(
  config: Config,
  snapshot: CompileSnapshot,
  mainFileInput: string,
  engine: "pdflatex" | "xelatex" | "lualatex",
  latexmkrcInput: string | null
): Promise<CompileResult> {
  const mainFile = safeRelativePath(mainFileInput);
  if (!mainFile.endsWith(".tex")) throw new Error("主文件必须是 .tex 文件");
  const startedAt = performance.now();
  let latexmkrc: string | null = null;
  if (config.allowProjectLatexmkrc && latexmkrcInput) {
    latexmkrc = safeRelativePath(latexmkrcInput);
    const absoluteRc = path.join(snapshot.sourceDir, latexmkrc);
    if (!fs.existsSync(absoluteRc) || !fs.statSync(absoluteRc).isFile()) {
      throw new Error(`项目 latexmkrc 不存在：${latexmkrc}`);
    }
  }
  const cacheStartedAt = performance.now();
  const cache = prepareCompileCache(config, snapshot, mainFile, engine, latexmkrc);
  const cacheSyncMs = performance.now() - cacheStartedAt;
  const cwd = cache.sourceDir;
  const outDir = cache.outputDir;

  const engineFlag = engine === "xelatex" ? "-xelatex" : engine === "lualatex" ? "-lualatex" : "-pdf";
  const args = [
    engineFlag,
    "-interaction=nonstopmode",
    "-file-line-error",
    "-halt-on-error",
    "-synctex=1",
    "-no-shell-escape",
    `-outdir=${outDir}`
  ];
  if (latexmkrc) args.push("-r", latexmkrc);
  args.push(...config.extraArgs, mainFile);

  const latexmkStartedAt = performance.now();
  const processResult = await new Promise<{ code: number | null; log: string }>((resolve, reject) => {
    const child = spawn(config.latexmk, args, {
      cwd,
      shell: false,
      env: { ...process.env, max_print_line: "1000" },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let log = "";
    const append = (chunk: Buffer): void => {
      log += chunk.toString("utf8");
      if (log.length > 2_000_000) log = log.slice(-2_000_000);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.on("error", reject);

    const timeout = setTimeout(() => {
      log += `\n编译超过 ${config.compileTimeoutMs / 1000} 秒，已终止。\n`;
      child.kill("SIGKILL");
    }, config.compileTimeoutMs);

    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({ code, log });
    });
  });
  const latexmkMs = performance.now() - latexmkStartedAt;
  const basename = path.basename(mainFile, ".tex");
  const cachedPdf = path.join(outDir, `${basename}.pdf`);
  const ok = processResult.code === 0 && fs.existsSync(cachedPdf);
  if (!ok) {
    return {
      ok: false, log: processResult.log, pdfPath: null, synctexPath: null,
      timings: { cacheSyncMs, latexmkMs, artifactCopyMs: 0, totalMs: performance.now() - startedAt }
    };
  }
  const artifactStartedAt = performance.now();
  const artifacts = materializeCompileArtifacts(cache, snapshot, basename);
  const artifactCopyMs = performance.now() - artifactStartedAt;
  return {
    ok: true, log: processResult.log, ...artifacts,
    timings: { cacheSyncMs, latexmkMs, artifactCopyMs, totalMs: performance.now() - startedAt }
  };
}
