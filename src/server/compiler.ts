import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import type { Config } from "./config.js";
import { listProjectFiles, outputRoot, safeRelativePath, sourceRoot } from "./files.js";

export interface CompileResult {
  ok: boolean;
  log: string;
  pdfPath: string | null;
  synctexPath: string | null;
}

export interface CompileSnapshot {
  runId: string;
  revision: string;
  root: string;
  sourceDir: string;
  outputDir: string;
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
  hash.update(JSON.stringify(settings));
  try {
    for (const entry of listProjectFiles(config, projectId).sort((left, right) => left.path.localeCompare(right.path))) {
      const destination = path.join(snapshotSource, entry.path);
      hash.update(`\0${entry.type}\0${entry.path}\0`);
      if (entry.type === "directory") {
        fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
        continue;
      }
      const content = fs.readFileSync(path.join(sourceRoot(config, projectId), entry.path));
      hash.update(content);
      fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
      fs.writeFileSync(destination, content, { mode: 0o600 });
    }
    return { runId, revision: hash.digest("hex"), root, sourceDir: snapshotSource, outputDir: snapshotOutput };
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

export async function compileProject(
  config: Config,
  snapshot: CompileSnapshot,
  mainFileInput: string,
  engine: "pdflatex" | "xelatex" | "lualatex",
  latexmkrcInput: string | null
): Promise<CompileResult> {
  const mainFile = safeRelativePath(mainFileInput);
  if (!mainFile.endsWith(".tex")) throw new Error("主文件必须是 .tex 文件");
  const cwd = snapshot.sourceDir;
  const outDir = snapshot.outputDir;
  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });

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
  if (config.allowProjectLatexmkrc && latexmkrcInput) {
    const latexmkrc = safeRelativePath(latexmkrcInput);
    const absoluteRc = path.join(cwd, latexmkrc);
    if (!fs.existsSync(absoluteRc) || !fs.statSync(absoluteRc).isFile()) {
      throw new Error(`项目 latexmkrc 不存在：${latexmkrc}`);
    }
    args.push("-r", latexmkrc);
  }
  args.push(...config.extraArgs, mainFile);

  return await new Promise<CompileResult>((resolve, reject) => {
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
      const pdfPath = path.join(outDir, `${path.basename(mainFile, ".tex")}.pdf`);
      const synctexPath = path.join(outDir, `${path.basename(mainFile, ".tex")}.synctex.gz`);
      const ok = code === 0 && fs.existsSync(pdfPath);
      resolve({
        ok, log,
        pdfPath: ok ? pdfPath : null,
        synctexPath: ok && fs.existsSync(synctexPath) ? synctexPath : null
      });
    });
  });
}
