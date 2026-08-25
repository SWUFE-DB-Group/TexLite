import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { gunzipSync, gzipSync } from "node:zlib";
import type { Config } from "./config.js";
import type { DatabaseConnection } from "./db.js";
import { listProjectFilesAsync, outputRoot, resolveSourcePath, safeRelativePath, sourceRoot, texFileStem } from "./files.js";
import { parseCompileDiagnostics, type CompileDiagnostics } from "./compileDiagnostics.js";
import { detachedProcessGroup, killProcessGroup } from "./processTree.js";

export interface CompileTimings {
  cacheSyncMs: number;
  latexmkMs: number;
  artifactCopyMs: number;
  publishMs?: number;
  totalMs: number;
}

export interface CompileResult {
  ok: boolean;
  /** The requester explicitly stopped this run before it could publish output. */
  cancelled?: boolean;
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
  /** Cheap source/settings generation used to skip an already-published build. */
  generation?: string;
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
  generation: string | null;
  source: string;
  output: string;
  pdf: string;
  synctex: string | null;
}

export interface CoordinatedCompileResult extends CompileResult {
  runId: string;
  revision: string;
  /** The snapshot was consistent, but newer edits arrived while it was copied. */
  stale?: boolean;
  /** Time spent creating the immutable source snapshot before compilation. */
  snapshotMs?: number;
  skipped?: boolean;
  retryable?: boolean;
  errorCode?: string;
}

/** A controlled stop is a normal compile outcome, never a server error. */
export class CompileCancelledError extends Error {
  constructor() {
    super("Compilation was cancelled.");
    this.name = "CompileCancelledError";
  }
}

export interface CoordinatedCompileJob {
  projectId: string;
  target?: string;
  runId: string;
  /**
   * Cheap source/settings generation used for request coalescing.  The
   * content digest is only available after a snapshot has been copied, so it
   * must not be used as the coordinator key at request admission time.
   */
  generation?: string;
  /** Backwards-compatible name used by callers that already provide a key. */
  revision: string;
  onQueued: () => void;
  onSelected: () => void;
  onDiscarded: (reason: "duplicate" | "superseded" | "cancelled") => void;
  /** Called only when a queued job is cancelled before execution begins. */
  onCancelled?: () => void;
  execute: (signal: AbortSignal) => Promise<CoordinatedCompileResult>;
}

type Task = () => Promise<void>;

export class CompileQueue {
  private running = 0;
  private readonly pending: Task[] = [];

  constructor(private readonly concurrency: number) {}

  add<T>(job: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let started = false;
      const cancelPending = () => {
        if (started) return;
        const index = this.pending.indexOf(task);
        if (index < 0) return;
        this.pending.splice(index, 1);
        reject(new CompileCancelledError());
        this.drain();
      };
      const task = async () => {
        started = true;
        signal?.removeEventListener("abort", cancelPending);
        if (signal?.aborted) {
          reject(new CompileCancelledError());
          return;
        }
        try {
          resolve(await job());
        } catch (error) {
          reject(error);
        }
      };
      if (signal?.aborted) {
        reject(new CompileCancelledError());
        return;
      }
      this.pending.push(task);
      signal?.addEventListener("abort", cancelPending, { once: true });
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
  controller: AbortController;
  started: boolean;
}

interface ProjectCompileState {
  active: ManagedCompileJob | null;
  pending: ManagedCompileJob | null;
}

/**
 * Coalesces and serializes each project/main-document target while still
 * respecting the server-wide LaTeX process limit. Different root documents
 * may compile concurrently because their caches and published bundles are
 * isolated by target.
 */
export class ProjectCompileCoordinator {
  private readonly targets = new Map<string, ProjectCompileState>();

  constructor(private readonly queue: CompileQueue) {}

  request(input: CoordinatedCompileJob): Promise<CoordinatedCompileResult> {
    const targetKey = `${input.projectId}\0${input.target ?? ""}`;
    const state = this.targets.get(targetKey) ?? { active: null, pending: null };
    this.targets.set(targetKey, state);
    const generation = input.generation ?? input.revision;

    const active = state.active;
    if (active && (active.input.generation ?? active.input.revision) === generation) {
      const pending = state.pending;
      if (pending) {
        this.redirect(pending, active);
        pending.input.onDiscarded("superseded");
        state.pending = null;
      }
      input.onDiscarded("duplicate");
      active.input.onSelected();
      return active.promise;
    }
    const pending = state.pending;
    if (pending && (pending.input.generation ?? pending.input.revision) === generation) {
      input.onDiscarded("duplicate");
      return pending.promise;
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

  /**
   * Stop the active target and discard any newer pending request for it. A
   * target has one writer-visible compile at a time, so cancelling the whole
   * target avoids immediately starting a stale follow-up compilation.
   */
  cancel(projectId: string, target?: string): { runId: string; status: "queued" | "running" } | null {
    const targetKey = `${projectId}\0${target ?? ""}`;
    const state = this.targets.get(targetKey);
    const active = state?.active;
    if (!active) return null;
    const status = active.started ? "running" : "queued";
    active.controller.abort();
    if (state?.pending) {
      const pending = state.pending;
      state.pending = null;
      pending.controller.abort();
      pending.input.onDiscarded("cancelled");
      pending.resolve(cancelledCompileResult(pending.input));
    }
    return { runId: active.input.runId, status };
  }

  private start(targetKey: string, state: ProjectCompileState, job: ManagedCompileJob): void {
    void this.queue.add(async () => {
      job.started = true;
      if (job.controller.signal.aborted) throw new CompileCancelledError();
      return await job.input.execute(job.controller.signal);
    }, job.controller.signal).then(job.resolve, (error: unknown) => {
      if (error instanceof CompileCancelledError) {
        job.input.onCancelled?.();
        job.resolve(cancelledCompileResult(job.input));
        return;
      }
      job.reject(error);
    }).finally(() => {
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
  return { input, promise, resolve, reject, controller: new AbortController(), started: false };
}

function cancelledCompileResult(input: CoordinatedCompileJob): CoordinatedCompileResult {
  return {
    runId: input.runId,
    revision: input.revision,
    ok: false,
    cancelled: true,
    log: new CompileCancelledError().message,
    diagnostics: { warnings: [], errors: [] },
    pdfPath: null,
    synctexPath: null
  };
}

export async function captureCompileSnapshot(
  config: Config,
  projectId: string,
  runId: string,
  settings: { mainFile: string; engine: string; latexmkrc: string | null; extraArgs: string[]; generation?: string }
): Promise<CompileSnapshot> {
  const root = compileRunRoot(config, projectId, runId);
  const snapshotSource = path.join(root, "source");
  const snapshotOutput = path.join(root, "output");
  await fs.promises.mkdir(snapshotSource, { recursive: true, mode: 0o700 });
  await fs.promises.mkdir(snapshotOutput, { recursive: true, mode: 0o700 });
  const hash = createHash("sha256");
  const files: CompileSnapshotFile[] = [];
  const directories: string[] = [];
  // The content revision remains independent from the cheap generation. A
  // metadata-only project update should still be able to reuse an identical
  // source snapshot after the generation check misses.
  const { generation, ...contentSettings } = settings;
  hash.update(JSON.stringify(contentSettings));
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
        const liveFile = resolveSourcePath(config, projectId, entry.path);
        const stat = await fs.promises.lstat(liveFile);
        if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Compile source path is not a regular file: ${entry.path}`);
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
      projectId, runId, mainFile: safeRelativePath(settings.mainFile), revision: hash.digest("hex"), generation, root,
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

/**
 * Returns whether the incremental latexmk cache for a root document exists.
 * A missing cache is intentionally treated as a request for a full rebuild,
 * even when a published PDF for the same source revision is still available.
 */
export function hasCompileCache(config: Config, projectId: string, mainFile: string): boolean {
  const cacheRoot = compileCacheTargetRoot(config, projectId, mainFile);
  try {
    return fs.readdirSync(cacheRoot, { withFileTypes: true }).some((entry) => entry.isDirectory());
  } catch {
    return false;
  }
}

/** Remove only incremental compiler state; the last published PDF remains available. */
export function cleanCompileCache(config: Config, projectId: string, mainFile: string): void {
  fs.rmSync(compileCacheTargetRoot(config, projectId, mainFile), { recursive: true, force: true });
}

/**
 * Remove generated output for one root document without touching project
 * source, settings, comments, history, or Git data.
 */
export function cleanCompileArtifacts(
  config: Config,
  projectId: string,
  mainFile: string,
  defaultMainFile: string,
  runIds: readonly string[] = []
): void {
  const published = publishedCompileArtifacts(config, projectId, mainFile, mainFile === defaultMainFile);
  cleanCompileCache(config, projectId, mainFile);
  fs.rmSync(compileTargetRoot(config, projectId, mainFile), { recursive: true, force: true });
  const runIdsToRemove = new Set(runIds);
  if (published) runIdsToRemove.add(published.runId);
  for (const runId of runIdsToRemove) {
    if (/^[a-f0-9-]{36}$/i.test(runId)) fs.rmSync(compileRunRoot(config, projectId, runId), { recursive: true, force: true });
  }
  if (mainFile === defaultMainFile) {
    const output = outputRoot(config, projectId);
    for (const generated of [
      path.join(output, ".texlite", "latest.json"),
      path.join(output, ".texlite", "latest.pdf"),
      path.join(output, ".texlite", "latest.synctex.gz"),
      path.join(output, `${texFileStem(mainFile)}.pdf`),
      path.join(output, `${texFileStem(mainFile)}.synctex.gz`)
    ]) fs.rmSync(generated, { force: true });
  }
}

export function publishCompileArtifacts(
  config: Config,
  projectId: string,
  snapshot: CompileSnapshot,
  result: CompileResult
): PublishedCompileArtifacts {
  if (!result.ok || !result.pdfPath) throw new Error("Cannot publish a failed compilation result");
  const manifestDirectory = compileTargetRoot(config, projectId, snapshot.mainFile);
  const previous = publishedCompileArtifacts(config, projectId, snapshot.mainFile);
  const manifest = {
    version: 2,
    mainFile: snapshot.mainFile,
    runId: snapshot.runId,
    revision: snapshot.revision,
    generation: snapshot.generation ?? null,
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

/**
 * Recover database run state after a crash between publishing an immutable
 * bundle and updating compile_runs. A valid published manifest is evidence
 * that latexmk produced a usable PDF, so the corresponding run must be
 * visible to latest/PDF endpoints after restart.
 */
export function reconcilePublishedCompileRuns(config: Config, db: DatabaseConnection, projectId: string): void {
  const recover = db.prepare(`UPDATE compile_runs
    SET status = 'succeeded', log = CASE WHEN log = '' THEN ? ELSE log END, finished_at = ?
    WHERE id = ? AND project_id = ?`);
  const insert = db.prepare(`INSERT OR IGNORE INTO compile_runs
    (id, project_id, requested_by, main_file, status, log, created_at, finished_at)
    VALUES (?, ?, NULL, ?, 'succeeded', ?, ?, ?)`);
  for (const artifact of listPublishedCompileArtifacts(config, projectId)) {
    let finishedAt = new Date().toISOString();
    try { finishedAt = fs.statSync(artifact.pdf).mtime.toISOString(); } catch { /* manifest validation already checked the file */ }
    const message = "Recovered a published PDF after a server restart.";
    const existing = db.prepare("SELECT status FROM compile_runs WHERE id = ? AND project_id = ?")
      .get(artifact.runId, projectId) as { status: string } | undefined;
    if (!existing) insert.run(artifact.runId, projectId, artifact.mainFile, message, finishedAt, finishedAt);
    else if (existing.status !== "succeeded") recover.run(message, finishedAt, artifact.runId, projectId);
  }
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
      version?: unknown; mainFile?: unknown; runId?: unknown; revision?: unknown; generation?: unknown; pdf?: unknown; synctex?: unknown;
    };
    const mainFile = manifest.version === 2 && typeof manifest.mainFile === "string"
      ? safeRelativePath(manifest.mainFile)
      : legacy && manifest.version === 1 ? expectedMainFile ?? "" : null;
    const generation = manifest.generation === undefined || manifest.generation === null
      ? null : typeof manifest.generation === "string" ? manifest.generation : null;
    if (mainFile === null || (expectedMainFile !== undefined && mainFile !== expectedMainFile)
      || typeof manifest.runId !== "string" || !/^[a-f0-9-]{36}$/i.test(manifest.runId)
      || typeof manifest.revision !== "string" || typeof manifest.pdf !== "string"
      || (manifest.generation !== undefined && manifest.generation !== null && generation === null)
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
    return { mainFile, runId: manifest.runId, revision: manifest.revision, generation, source, output, pdf, synctex };
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

function compileCacheTargetRoot(config: Config, projectId: string, mainFile: string): string {
  return path.join(compileDataRoot(config, projectId), "cache", compileTargetKey(mainFile));
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
  const cacheDirectory = compileCacheTargetRoot(config, snapshot.projectId, mainFile);
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
  latexmkrcInput: string | null,
  options: { signal?: AbortSignal } = {}
): Promise<CompileResult> {
  const { signal } = options;
  if (signal?.aborted) return cancelledCompileResultForProject();
  const mainFile = safeRelativePath(mainFileInput);
  if (!/\.tex$/i.test(mainFile)) throw new Error("The main file must have a .tex extension");
  const startedAt = performance.now();
  let latexmkrc: string | null = null;
  if (config.allowProjectLatexmkrc && latexmkrcInput) {
    latexmkrc = safeRelativePath(latexmkrcInput);
    const absoluteRc = path.join(snapshot.sourceDir, latexmkrc);
    if (!fs.existsSync(absoluteRc) || !fs.statSync(absoluteRc).isFile()) {
      throw new Error(`The configured project latexmkrc does not exist: ${latexmkrc}`);
    }
  }
  const cacheStartedAt = performance.now();
  const cache = prepareCompileCache(config, snapshot, mainFile, engine, latexmkrc);
  const cacheSyncMs = performance.now() - cacheStartedAt;
  if (signal?.aborted) return cancelledCompileResultForProject({
    cacheSyncMs, latexmkMs: 0, artifactCopyMs: 0, totalMs: performance.now() - startedAt
  });
  const cwd = cache.sourceDir;
  const outDir = cache.outputDir;

  const engineFlag = engine === "xelatex" ? "-xelatex" : engine === "lualatex" ? "-lualatex" : "-pdf";
  const args = [
    engineFlag,
    // latexmk otherwise reads a .latexmkrc from the compile working
    // directory automatically.  Project sources may contain one after a ZIP
    // import or a Git checkout, so only an rc file explicitly selected in the
    // project settings may be loaded below with -r.
    "-norc",
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
  const processResult = await new Promise<{ code: number | null; log: string; cancelled: boolean }>((resolve, reject) => {
    const child = spawn(config.latexmk, args, {
      cwd,
      shell: false,
      detached: detachedProcessGroup(),
      env: { ...process.env, max_print_line: "1000" },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let log = "";
    let cancelled = false;
    const append = (chunk: Buffer): void => {
      log += chunk.toString("utf8");
      if (log.length > 2_000_000) log = log.slice(-2_000_000);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);

    let timeout: ReturnType<typeof setTimeout> | null = null;
    const cancel = () => {
      if (cancelled) return;
      cancelled = true;
      log += "\nCompilation was cancelled.\n";
      killProcessGroup(child);
    };
    const removeAbortListener = () => signal?.removeEventListener("abort", cancel);
    child.once("error", (error) => {
      if (timeout) clearTimeout(timeout);
      removeAbortListener();
      reject(error);
    });

    timeout = setTimeout(() => {
      if (cancelled) return;
      log += `\nCompilation exceeded ${config.compileTimeoutMs / 1000} seconds and was terminated.\n`;
      killProcessGroup(child);
    }, config.compileTimeoutMs);

    if (signal?.aborted) cancel();
    else signal?.addEventListener("abort", cancel, { once: true });

    child.on("close", (code) => {
      if (timeout) clearTimeout(timeout);
      removeAbortListener();
      resolve({ code, log, cancelled });
    });
  });
  const latexmkMs = performance.now() - latexmkStartedAt;
  const basename = texFileStem(mainFile);
  const cachedPdf = path.join(outDir, `${basename}.pdf`);
  if (processResult.cancelled || signal?.aborted) {
    return cancelledCompileResultForProject({
      cacheSyncMs, latexmkMs, artifactCopyMs: 0, totalMs: performance.now() - startedAt
    }, processResult.log);
  }
  const ok = processResult.code === 0 && fs.existsSync(cachedPdf);
  const diagnostics = parseCompileDiagnostics(processResult.log, ok ? "succeeded" : "failed");
  if (!ok) {
    return {
      ok: false, log: processResult.log, diagnostics, pdfPath: null, synctexPath: null,
      timings: { cacheSyncMs, latexmkMs, artifactCopyMs: 0, totalMs: performance.now() - startedAt }
    };
  }
  if (signal?.aborted) return cancelledCompileResultForProject({
    cacheSyncMs, latexmkMs, artifactCopyMs: 0, totalMs: performance.now() - startedAt
  });
  const artifactStartedAt = performance.now();
  const artifacts = materializeCompileArtifacts(cache, snapshot, basename);
  const artifactCopyMs = performance.now() - artifactStartedAt;
  return {
    ok: true, log: processResult.log, diagnostics, ...artifacts,
    timings: { cacheSyncMs, latexmkMs, artifactCopyMs, totalMs: performance.now() - startedAt }
  };
}

function cancelledCompileResultForProject(timings?: CompileTimings, log = ""): CompileResult {
  const message = log.includes("Compilation was cancelled.")
    ? log
    : `${log}${log && !log.endsWith("\n") ? "\n" : ""}Compilation was cancelled.\n`;
  return {
    ok: false,
    cancelled: true,
    log: message,
    diagnostics: parseCompileDiagnostics(message, "failed"),
    pdfPath: null,
    synctexPath: null,
    ...(timings ? { timings } : {})
  };
}
