import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { maskLatexSource } from "./latexSpellMask.js";

export interface RawHarperLint {
  start: number;
  end: number;
  problem: string;
  kind: string;
  message: string;
  suggestions: string[];
}

interface HarperCliLint {
  kind?: unknown;
  message?: unknown;
  matched_text?: unknown;
  span?: { char_start?: unknown; char_end?: unknown };
  suggestions?: unknown;
}

interface HarperCliDocument {
  lints?: unknown;
}

interface CachedLintResult {
  expiresAt: number;
  lints: RawHarperLint[];
}

const commandProbeTimeoutMs = 5_000;
const lintTimeoutMs = 30_000;
const maxCommandOutputBytes = 8 * 1024 * 1024;
const maxCachedSourceBytes = 512 * 1024;
const maxCachedResults = 24;
const cacheTtlMs = 15_000;
const unavailableRetryMs = 15_000;

export class HarperUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HarperUnavailableError";
  }
}

function lintCacheKey(source: string, filePath: string): string {
  // Harper selects its parser from the input suffix, so equivalent text in a
  // .tex and a .sty file must not share a diagnostic result.
  return createHash("sha256").update(temporaryFileExtension(filePath)).update("\0").update(source).digest("base64url");
}

function temporaryFileExtension(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  // Harper selects its TeX parser by extension. Treat source-like companion
  // files as TeX too; BibTeX keys are intentionally not grammar-checked.
  return extension === ".tex" || extension === ".sty" || extension === ".cls" ? extension : ".tex";
}

function replacementText(suggestion: string): string | null {
  const match = /^Replace with:\s*[“"]([\s\S]*)[”"]$/u.exec(suggestion.trim());
  return match?.[1] ?? null;
}

/** Parse `harper-cli lint --format json` output into the browser API shape. */
export function parseHarperCliOutput(output: string): RawHarperLint[] {
  let documents: unknown;
  try {
    documents = JSON.parse(output);
  } catch {
    throw new Error("Harper returned invalid JSON.");
  }
  if (!Array.isArray(documents)) throw new Error("Harper returned an unexpected result.");

  const lints: RawHarperLint[] = [];
  for (const document of documents as HarperCliDocument[]) {
    if (!Array.isArray(document.lints)) continue;
    for (const lint of document.lints as HarperCliLint[]) {
      const start = lint.span?.char_start;
      const end = lint.span?.char_end;
      if (typeof start !== "number" || typeof end !== "number" || !Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start) continue;
      const suggestions = Array.isArray(lint.suggestions)
        ? lint.suggestions.filter((value): value is string => typeof value === "string")
          .map(replacementText).filter((value): value is string => value !== null)
        : [];
      lints.push({
        start,
        end,
        problem: typeof lint.matched_text === "string" ? lint.matched_text : "",
        kind: typeof lint.kind === "string" ? lint.kind : "Grammar",
        message: typeof lint.message === "string" ? lint.message : "Harper found a writing issue.",
        suggestions: [...new Set(suggestions)].slice(0, 5)
      });
    }
  }
  return lints;
}

/**
 * Optional host-side Harper integration. `harper-cli` is distributed with
 * Harper/harper-ls and provides native TeX parsing plus structured fixes,
 * without bundling a WASM runtime into TexLite.
 */
export class HarperService {
  private availability: "unknown" | "available" | "unavailable" = "unknown";
  private lastUnavailableAt = 0;
  private probePromise: Promise<void> | null = null;
  private queue: Promise<void> = Promise.resolve();
  private readonly inFlight = new Map<string, Promise<RawHarperLint[]>>();
  private readonly cache = new Map<string, CachedLintResult>();
  private activeChild: ChildProcess | null = null;
  private disposed = false;

  constructor(private readonly command = "harper-cli") {}

  async preload(): Promise<void> {
    await this.ensureAvailable();
  }

  async lint(source: string, filePath = "main.tex"): Promise<RawHarperLint[]> {
    if (this.disposed) throw new HarperUnavailableError("Harper service stopped.");
    const key = lintCacheKey(source, filePath);
    const cacheable = Buffer.byteLength(source, "utf8") <= maxCachedSourceBytes;
    const cached = cacheable ? this.cachedResult(key) : null;
    if (cached) return cached;
    const existing = cacheable ? this.inFlight.get(key) : undefined;
    if (existing) return existing;

    const operation = this.queue.then(() => this.lintOnce(source, filePath));
    this.queue = operation.then(() => undefined, () => undefined);
    if (cacheable) {
      this.inFlight.set(key, operation);
      void operation.then(
        (lints) => this.cacheResult(key, lints),
        () => undefined
      ).finally(() => {
        if (this.inFlight.get(key) === operation) this.inFlight.delete(key);
      });
    }
    return operation;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.activeChild?.kill("SIGTERM");
    await this.queue.catch(() => undefined);
    this.inFlight.clear();
    this.cache.clear();
  }

  private async ensureAvailable(): Promise<void> {
    if (this.availability === "available") return;
    if (this.availability === "unavailable" && Date.now() - this.lastUnavailableAt < unavailableRetryMs) {
      throw new HarperUnavailableError(`The optional ${this.command} command is not available.`);
    }
    if (this.probePromise) return this.probePromise;
    this.probePromise = this.runCommand(["--version"], commandProbeTimeoutMs, 64 * 1024)
      .then(({ code }) => {
        if (code !== 0) throw new Error(`${this.command} exited with code ${code}.`);
        this.availability = "available";
      })
      .catch((error) => {
        this.availability = "unavailable";
        this.lastUnavailableAt = Date.now();
        const detail = error instanceof Error ? error.message : String(error);
        throw new HarperUnavailableError(`The optional ${this.command} command is unavailable: ${detail}`);
      })
      .finally(() => { this.probePromise = null; });
    return this.probePromise;
  }

  private async lintOnce(source: string, filePath: string): Promise<RawHarperLint[]> {
    await this.ensureAvailable();
    const directory = await mkdtemp(path.join(tmpdir(), "texlite-harper-"));
    const input = path.join(directory, `document${temporaryFileExtension(filePath)}`);
    try {
      await writeFile(input, maskLatexSource(source), { encoding: "utf8", mode: 0o600 });
      const { code, stdout, stderr } = await this.runCommand([
        "lint", "--format", "json", "--quiet",
        "--user-dict-path", path.join(directory, "dictionary.txt"),
        "--file-dict-path", path.join(directory, "file-dictionaries"),
        input
      ], lintTimeoutMs, maxCommandOutputBytes);
      // Harper exits with one when it found lints. Any other non-zero status is
      // a command failure, not a spelling result.
      if (code !== 0 && code !== 1) throw new Error(stderr.trim() || `${this.command} exited with code ${code}.`);
      return parseHarperCliOutput(stdout);
    } finally {
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private cachedResult(key: string): RawHarperLint[] | null {
    const cached = this.cache.get(key);
    if (!cached || cached.expiresAt < Date.now()) {
      this.cache.delete(key);
      return null;
    }
    this.cache.delete(key);
    this.cache.set(key, cached);
    return cached.lints;
  }

  private cacheResult(key: string, lints: RawHarperLint[]): void {
    this.cache.set(key, { expiresAt: Date.now() + cacheTtlMs, lints });
    while (this.cache.size > maxCachedResults) {
      const oldest = this.cache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }

  private runCommand(args: string[], timeoutMs: number, outputLimit: number): Promise<{ code: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = spawn(this.command, args, { stdio: ["ignore", "pipe", "pipe"] });
      } catch (error) {
        reject(error);
        return;
      }
      this.activeChild = child;
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let outputBytes = 0;
      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (this.activeChild === child) this.activeChild = null;
        callback();
      };
      const fail = (error: Error) => finish(() => reject(error));
      timer = setTimeout(() => {
        child.kill("SIGTERM");
        fail(new Error(`${this.command} timed out after ${Math.ceil(timeoutMs / 1000)} seconds.`));
      }, timeoutMs);
      const collect = (target: Buffer[]) => (chunk: Buffer) => {
        outputBytes += chunk.length;
        if (outputBytes > outputLimit) {
          child.kill("SIGTERM");
          fail(new Error(`${this.command} produced too much output.`));
          return;
        }
        target.push(chunk);
      };
      child.stdout!.on("data", collect(stdout));
      child.stderr!.on("data", collect(stderr));
      child.once("error", (error) => fail(error));
      child.once("close", (code) => finish(() => resolve({
        code,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8")
      })));
    });
  }
}
