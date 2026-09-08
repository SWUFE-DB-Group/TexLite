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

interface ScheduledLint {
  key: string;
  source: string;
  filePath: string;
  started: boolean;
  cancelled: boolean;
  /** Browser lanes currently waiting for this shared queued operation. */
  lanes: Set<string>;
  /** A caller without a lane still expects this operation to run. */
  hasUnscopedWaiter: boolean;
  promise: Promise<RawHarperLint[]>;
  resolve: (lints: RawHarperLint[]) => void;
  reject: (error: unknown) => void;
}

const commandProbeTimeoutMs = 5_000;
const lintTimeoutMs = 30_000;
const maxCommandOutputBytes = 8 * 1024 * 1024;
const maxCachedSourceBytes = 512 * 1024;
const maxCachedResults = 24;
const cacheTtlMs = 15_000;
const unavailableRetryMs = 15_000;
// A browser can send an older request after a newer one when HTTP requests
// race. Keep the latest sequence briefly so that late arrivals cannot replace
// a newer queued revision. The bound is intentionally generous for a small
// collaborative installation while keeping abandoned browser-page lanes from
// accumulating forever.
const laneSequenceRetentionMs = 10 * 60_000;
const maxTrackedLaneSequences = 512;

interface LaneSequence {
  sequence: number;
  key: string;
  seenAt: number;
}

export class HarperUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HarperUnavailableError";
  }
}

/** A newer source revision made a waiting writing check irrelevant. */
export class HarperLintSupersededError extends Error {
  constructor() {
    super("A newer writing check replaced this request.");
    this.name = "HarperLintSupersededError";
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
  /** One harper-cli process at a time; Harper itself is comparatively heavy. */
  private queueRunner: Promise<void> | null = null;
  // Set preserves insertion order, giving the scheduler FIFO behaviour while
  // allowing a superseded waiting item to be removed immediately. An array
  // would otherwise retain its complete source string until the active check
  // finishes.
  private readonly queued = new Set<ScheduledLint>();
  /** Only waiting work belongs here; a running process must finish safely. */
  private readonly waitingByLane = new Map<string, ScheduledLint>();
  /** Latest accepted browser revision for each project/user/page/file lane. */
  private readonly latestSequenceByLane = new Map<string, LaneSequence>();
  private readonly inFlight = new Map<string, Promise<RawHarperLint[]>>();
  /** Lets coalesced browser lanes share one queued operation safely. */
  private readonly scheduledByKey = new Map<string, ScheduledLint>();
  private readonly cache = new Map<string, CachedLintResult>();
  private activeChild: ChildProcess | null = null;
  private disposed = false;

  constructor(private readonly command = "harper-cli") {}

  async preload(): Promise<void> {
    await this.ensureAvailable();
  }

  /**
   * Schedule one host-side check. A lane represents one browser page's
   * current file, so an edit can replace only its own stale waiting request
   * without cancelling checks requested by collaborators.
   */
  async lint(source: string, filePath = "main.tex", lane?: string, sequence?: number): Promise<RawHarperLint[]> {
    if (this.disposed) throw new HarperUnavailableError("Harper service stopped.");
    const key = lintCacheKey(source, filePath);
    const laneKey = lane || null;
    if (laneKey && sequence !== undefined) this.acceptLaneSequence(laneKey, sequence, key);
    const waiting = laneKey ? this.waitingByLane.get(laneKey) : undefined;
    // Repeated requests for the same queued revision share it. A newer
    // revision replaces only work that has not started yet.
    if (waiting?.key === key) return waiting.promise;
    if (laneKey && waiting) this.releaseWaitingLane(laneKey, waiting);

    const cacheable = Buffer.byteLength(source, "utf8") <= maxCachedSourceBytes;
    const cached = cacheable ? this.cachedResult(key) : null;
    if (cached) return cached;
    // Result caching is deliberately size-bounded, but duplicate active work
    // is still coalesced for large files. The latter is transient and avoids
    // starting multiple expensive CLI processes for identical content.
    const existing = this.inFlight.get(key);
    if (existing) {
      const scheduled = this.scheduledByKey.get(key);
      if (laneKey && scheduled) this.addWaitingLane(scheduled, laneKey);
      else if (scheduled && !scheduled.started) scheduled.hasUnscopedWaiter = true;
      return existing;
    }

    let resolve!: (lints: RawHarperLint[]) => void;
    let reject!: (error: unknown) => void;
    const operation = new Promise<RawHarperLint[]>((resolveOperation, rejectOperation) => {
      resolve = resolveOperation;
      reject = rejectOperation;
    });
    const scheduled: ScheduledLint = {
      key,
      source,
      filePath,
      started: false,
      cancelled: false,
      lanes: laneKey ? new Set([laneKey]) : new Set(),
      hasUnscopedWaiter: laneKey === null,
      promise: operation,
      resolve,
      reject
    };
    this.inFlight.set(key, operation);
    this.scheduledByKey.set(key, scheduled);
    if (laneKey) this.waitingByLane.set(laneKey, scheduled);
    this.queued.add(scheduled);
    this.startQueue();

    if (cacheable) {
      void operation.then(
        (lints) => this.cacheResult(key, lints),
        () => undefined
      ).finally(() => {
        if (this.inFlight.get(key) === operation) this.inFlight.delete(key);
        if (this.scheduledByKey.get(key) === scheduled) this.scheduledByKey.delete(key);
      });
    } else {
      // Attach a rejection handler even for uncached results. This keeps a
      // superseded request from becoming an unhandled rejection when a client
      // disconnects before it awaits the response.
      void operation.catch(() => undefined).finally(() => {
        if (this.inFlight.get(key) === operation) this.inFlight.delete(key);
        if (this.scheduledByKey.get(key) === scheduled) this.scheduledByKey.delete(key);
      });
    }
    return operation;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    const stopped = new HarperUnavailableError("Harper service stopped.");
    for (const scheduled of [...this.queued]) {
      if (!scheduled.cancelled && !scheduled.started) {
        scheduled.cancelled = true;
        this.discardQueuedLint(scheduled);
        scheduled.reject(stopped);
      }
    }
    this.waitingByLane.clear();
    this.latestSequenceByLane.clear();
    this.activeChild?.kill("SIGTERM");
    await this.queueRunner?.catch(() => undefined);
    this.inFlight.clear();
    this.scheduledByKey.clear();
    this.cache.clear();
  }

  private addWaitingLane(scheduled: ScheduledLint, lane: string): void {
    if (scheduled.started || scheduled.cancelled) return;
    scheduled.lanes.add(lane);
    this.waitingByLane.set(lane, scheduled);
  }

  private releaseWaitingLane(lane: string, scheduled: ScheduledLint): void {
    if (this.waitingByLane.get(lane) === scheduled) this.waitingByLane.delete(lane);
    scheduled.lanes.delete(lane);
    // The exact same queued source can be requested by multiple sessions.
    // Discard it only after every interested lane has moved on.
    if (scheduled.started || scheduled.cancelled || scheduled.hasUnscopedWaiter || scheduled.lanes.size > 0) return;
    this.cancelScheduledLint(scheduled);
  }

  private cancelScheduledLint(scheduled: ScheduledLint): void {
    if (scheduled.started || scheduled.cancelled) return;
    scheduled.cancelled = true;
    for (const lane of scheduled.lanes) {
      if (this.waitingByLane.get(lane) === scheduled) this.waitingByLane.delete(lane);
    }
    scheduled.lanes.clear();
    // Remove this rejected promise immediately so a later return to the same
    // text can enqueue fresh work instead of inheriting a stale rejection.
    if (this.inFlight.get(scheduled.key) === scheduled.promise) {
      this.inFlight.delete(scheduled.key);
    }
    if (this.scheduledByKey.get(scheduled.key) === scheduled) {
      this.scheduledByKey.delete(scheduled.key);
    }
    this.discardQueuedLint(scheduled);
    scheduled.reject(new HarperLintSupersededError());
  }

  /** Remove a waiting task and promptly release its potentially large text. */
  private discardQueuedLint(scheduled: ScheduledLint): void {
    this.queued.delete(scheduled);
    scheduled.source = "";
    scheduled.filePath = "";
  }

  /** Reject an out-of-order request before it can alter queued work. */
  private acceptLaneSequence(lane: string, sequence: number, key: string): void {
    if (!Number.isSafeInteger(sequence) || sequence <= 0) {
      throw new HarperLintSupersededError();
    }
    const now = Date.now();
    this.pruneLaneSequences(now);
    const previous = this.latestSequenceByLane.get(lane);
    if (previous && (sequence < previous.sequence || (sequence === previous.sequence && previous.key !== key))) {
      throw new HarperLintSupersededError();
    }
    // Refresh insertion order so the bounded map evicts the least recently
    // used abandoned page lane first.
    this.latestSequenceByLane.delete(lane);
    this.latestSequenceByLane.set(lane, { sequence, key, seenAt: now });
    while (this.latestSequenceByLane.size > maxTrackedLaneSequences) {
      const oldest = this.latestSequenceByLane.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.latestSequenceByLane.delete(oldest);
    }
  }

  private pruneLaneSequences(now: number): void {
    for (const [lane, state] of this.latestSequenceByLane) {
      if (now - state.seenAt <= laneSequenceRetentionMs) continue;
      this.latestSequenceByLane.delete(lane);
    }
  }

  private startQueue(): void {
    if (this.queueRunner) return;
    this.queueRunner = (async () => {
      while (!this.disposed) {
        const scheduled = this.queued.values().next().value as ScheduledLint | undefined;
        if (!scheduled) return;
        this.queued.delete(scheduled);
        if (scheduled.cancelled) continue;
        scheduled.started = true;
        for (const lane of scheduled.lanes) {
          if (this.waitingByLane.get(lane) === scheduled) this.waitingByLane.delete(lane);
        }
        scheduled.lanes.clear();
        try {
          scheduled.resolve(await this.lintOnce(scheduled.source, scheduled.filePath));
        } catch (error) {
          scheduled.reject(error);
        }
      }
    })().finally(() => {
      this.queueRunner = null;
      // A request can arrive just after the loop observes an empty queue.
      if (!this.disposed && this.queued.size) this.startQueue();
    });
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

  protected runCommand(args: string[], timeoutMs: number, outputLimit: number): Promise<{ code: number | null; stdout: string; stderr: string }> {
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
