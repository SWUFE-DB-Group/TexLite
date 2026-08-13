import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { gunzipSync, gzipSync } from "node:zlib";
import type { Config } from "./config.js";
import { listProjectFilesAsync, outputRoot, safeRelativePath, sourceRoot } from "./files.js";
import { parseCompileDiagnostics, type CompileDiagnostics } from "./compileDiagnostics.js";

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
  diagnostics: CompileDiagnostics;
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
  mainFile: string;
  revision: string;
  root: string;
  sourceDir: string;
  outputDir: string;
  files: CompileSnapshotFile[];
  directories: string[];
}

export interface PublishedCompileArtifacts {
  mainFile: string;
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
  target?: string;
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

  stats(): { concurrency: number; running: number; pending: number } {
    return { concurrency: this.concurrency, running: this.running, pending: this.pending.length };
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
  private readonly targets = new Map<string, ProjectCompileState>();

  constructor(private readonly queue: CompileQueue) {}

  request(input: CoordinatedCompileJob): Promise<CoordinatedCompileResult> {
    const targetKey = `${input.projectId}\0${input.target ?? ""}`;
    const state = this.targets.get(targetKey) ?? { active: null, pending: null };
    this.targets.set(targetKey, state);

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
      this.start(targetKey, state, managed);
    }
    return managed.promise;
  }

  private start(targetKey: string, state: ProjectCompileState, job: ManagedCompileJob): void {
    void this.queue.add(job.input.execute).then(job.resolve, job.reject).finally(() => {
      if (state.active !== job) return;
      state.active = null;
      const next = state.pending;
      state.pending = null;
      if (next) {
        state.active = next;
        next.input.onQueued();
        this.start(targetKey, state, next);
      } else {
        this.targets.delete(targetKey);
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

export async function captureCompileSnapshot(
  config: Config,
  projectId: string,
  runId: string,
  settings: { mainFile: string; engine: string; latexmkrc: string | null; extraArgs: string[] }
): Promise<CompileSnapshot> {
  const root = compileRunRoot(config, projectId, runId);
  const snapshotSource = path.join(root, "source");
  const snapshotOutput = path.join(root, "output");
  await fs.promises.mkdir(snapshotSource, { recursive: true, mode: 0o700 });
  await fs.promises.mkdir(snapshotOutput, { recursive: true, mode: 0o700 });
  const hash = createHash("sha256");
  const files: CompileSnapshotFile[] = [];
  const directories: string[] = [];
  hash.update(JSON.stringify(settings));
  try {
    const entries = (await listProjectFilesAsync(config, projectId)).sort((left, right) => left.path.localeCompare(right.path));
    const fileEntries = entries.filter((entry) => entry.type === "file");
    for (const entry of entries) {
      const destination = path.join(snapshotSource, entry.path);
      hash.update(`\0${entry.type}\0${entry.path}\0`);
      if (entry.type === "directory") {
        await fs.promises.mkdir(destination, { recursive: true, mode: 0o700 });
        directories.push(entry.path);
      }
    }
    // Four concurrent streams improve snapshot latency for typical papers with
    // many figures without creating unbounded disk pressure on a shared host.
    for (let offset = 0; offset < fileEntries.length; offset += 4) {
      const batch = fileEntries.slice(offset, offset + 4);
      const settled = await Promise.allSettled(batch.map(async (entry): Promise<CompileSnapshotFile> => {
        const destination = path.join(snapshotSource, entry.path);
        const liveFile = path.join(sourceRoot(config, projectId), entry.path);
        const stat = await fs.promises.stat(liveFile);
        await fs.promises.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
        const digest = await copyAndDigest(liveFile, destination);
        await fs.promises.utimes(destination, stat.atime, stat.mtime);
        return { path: entry.path, digest, size: stat.size, mtimeMs: stat.mtimeMs };
      }));
      const failed = settled.find((result): result is PromiseRejectedResult => result.status === "rejected");
      if (failed) throw failed.reason;
      files.push(...settled.map((result) => (result as PromiseFulfilledResult<CompileSnapshotFile>).value));
    }
    for (const file of files) hash.update(file.digest);
    return {
      projectId, runId, mainFile: safeRelativePath(settings.mainFile), revision: hash.digest("hex"), root,
      sourceDir: snapshotSource, outputDir: snapshotOutput, files, directories
    };
  } catch (error) {
    await fs.promises.rm(root, { recursive: true, force: true });
    throw error;
  }
}

async function copyAndDigest(source: string, destination: string): Promise<string> {
  const digest = createHash("sha256");
  const hasher = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      digest.update(chunk);
      callback(null, chunk);
    }
  });
  await pipeline(fs.createReadStream(source), hasher, fs.createWriteStream(destination, { mode: 0o600 }));
  return digest.digest("hex");
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
  const manifestDirectory = compileTargetRoot(config, projectId, snapshot.mainFile);
  const previous = publishedCompileArtifacts(config, projectId, snapshot.mainFile);
  const manifest = {
    version: 2,
    mainFile: snapshot.mainFile,
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
  return publishedCompileArtifacts(config, projectId, snapshot.mainFile)!;
}

export function publishedCompileArtifacts(
  config: Config,
  projectId: string,
  mainFile?: string,
  allowLegacy = false
): PublishedCompileArtifacts | null {
  if (mainFile !== undefined) {
    const normalized = safeRelativePath(mainFile);
    const targeted = readPublishedManifest(config, projectId, path.join(compileTargetRoot(config, projectId, normalized), "latest.json"), normalized);
    if (targeted) return targeted;
    return allowLegacy ? readPublishedManifest(config, projectId, path.join(compileDataRoot(config, projectId), "latest.json"), normalized, true) : null;
  }
  const legacy = readPublishedManifest(config, projectId, path.join(compileDataRoot(config, projectId), "latest.json"), "", true);
  if (legacy) return legacy;
  return listPublishedCompileArtifacts(config, projectId)
    .sort((left, right) => fs.statSync(right.pdf).mtimeMs - fs.statSync(left.pdf).mtimeMs)[0] ?? null;
}

export function listPublishedCompileArtifacts(config: Config, projectId: string): PublishedCompileArtifacts[] {
  const result: PublishedCompileArtifacts[] = [];
  const targetsRoot = path.join(compileDataRoot(config, projectId), "targets");
  if (fs.existsSync(targetsRoot)) {
    for (const entry of fs.readdirSync(targetsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const artifact = readPublishedManifest(config, projectId, path.join(targetsRoot, entry.name, "latest.json"));
      if (artifact) result.push(artifact);
    }
  }
  const legacy = readPublishedManifest(config, projectId, path.join(compileDataRoot(config, projectId), "latest.json"), "", true);
  if (legacy && !result.some((artifact) => artifact.runId === legacy.runId)) result.push(legacy);
  return result;
}

function readPublishedManifest(
  config: Config,
  projectId: string,
  manifestPath: string,
  expectedMainFile?: string,
  legacy = false
): PublishedCompileArtifacts | null {
  if (!fs.existsSync(manifestPath)) return null;
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
      version?: unknown; mainFile?: unknown; runId?: unknown; revision?: unknown; pdf?: unknown; synctex?: unknown;
    };
    const mainFile = manifest.version === 2 && typeof manifest.mainFile === "string"
      ? safeRelativePath(manifest.mainFile)
      : legacy && manifest.version === 1 ? expectedMainFile ?? "" : null;
    if (mainFile === null || (expectedMainFile !== undefined && mainFile !== expectedMainFile)
      || typeof manifest.runId !== "string" || !/^[a-f0-9-]{36}$/i.test(manifest.runId)
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
    return { mainFile, runId: manifest.runId, revision: manifest.revision, source, output, pdf, synctex };
  } catch {
    return null;
  }
}

/** Remove run bundles left by an interrupted process, preserving the published PDF. */
export function pruneOrphanedCompileRuns(config: Config, projectId: string): void {
  const runsRoot = path.join(compileDataRoot(config, projectId), "runs");
  const publishedRunIds = new Set(listPublishedCompileArtifacts(config, projectId).map((artifact) => artifact.runId));
  if (!fs.existsSync(runsRoot)) return;
  for (const entry of fs.readdirSync(runsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || publishedRunIds.has(entry.name)) continue;
    fs.rmSync(path.join(runsRoot, entry.name), { recursive: true, force: true });
  }
}

function compileDataRoot(config: Config, projectId: string): string {
  return path.join(outputRoot(config, projectId), ".texlite");
}

function compileTargetRoot(config: Config, projectId: string, mainFile: string): string {
  return path.join(compileDataRoot(config, projectId), "targets", compileTargetKey(mainFile));
}

function compileTargetKey(mainFile: string): string {
  return createHash("sha256").update(safeRelativePath(mainFile)).digest("hex").slice(0, 24);
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
  const cacheDirectory = path.join(
    compileDataRoot(config, snapshot.projectId), "cache", compileTargetKey(mainFile)
  );
  const key = compileCacheKey(config, snapshot, mainFile, engine, latexmkrc);
  const root = path.join(cacheDirectory, key);
  const cacheSource = path.join(root, "source");
  const cacheOutput = path.join(root, "output");
  const statePath = path.join(root, "state.json");
  fs.mkdirSync(cacheSource, { recursive: true, mode: 0o700 });
  fs.mkdirSync(cacheOutput, { recursive: true, mode: 0o700 });
  // Jobs for this root are serialized, so stale compiler-setting variants can
  // be removed safely. Sibling root caches live in other directories and may
  // be in use by another session.
  for (const entry of fs.readdirSync(cacheDirectory, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name !== key) {
      fs.rmSync(path.join(cacheDirectory, entry.name), { recursive: true, force: true });
    }
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
  const diagnostics = parseCompileDiagnostics(processResult.log, ok ? "succeeded" : "failed");
  if (!ok) {
    return {
      ok: false, log: processResult.log, diagnostics, pdfPath: null, synctexPath: null,
      timings: { cacheSyncMs, latexmkMs, artifactCopyMs: 0, totalMs: performance.now() - startedAt }
    };
  }
  const artifactStartedAt = performance.now();
  const artifacts = materializeCompileArtifacts(cache, snapshot, basename);
  const artifactCopyMs = performance.now() - artifactStartedAt;
  return {
    ok: true, log: processResult.log, diagnostics, ...artifacts,
    timings: { cacheSyncMs, latexmkMs, artifactCopyMs, totalMs: performance.now() - startedAt }
  };
}
