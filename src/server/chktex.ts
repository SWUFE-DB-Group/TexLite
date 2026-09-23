import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { detachedProcessGroup, killProcessGroup } from "./processTree.js";

/** A stable, line-based representation of one ChkTeX diagnostic. */
export interface RawChktexLint {
  line: number;
  column: number;
  length: number;
  number: number | null;
  message: string;
}

interface CachedResult {
  expiresAt: number;
  lints: RawChktexLint[];
}

interface ScheduledCheck {
  key: string;
  source: string;
  filePath: string;
  started: boolean;
  cancelled: boolean;
  lanes: Set<string>;
  hasUnscopedWaiter: boolean;
  promise: Promise<RawChktexLint[]>;
  resolve: (lints: RawChktexLint[]) => void;
  reject: (error: unknown) => void;
}

const commandProbeTimeoutMs = 5_000;
const checkTimeoutMs = 5_000;
const maxOutputBytes = 2 * 1024 * 1024;
const maxCachedSourceBytes = 512 * 1024;
const maxCachedResults = 24;
const cacheTtlMs = 15_000;
const unavailableRetryMs = 15_000;
const laneSequenceRetentionMs = 10 * 60_000;
const maxTrackedLaneSequences = 512;
const maxConcurrency = 8;
// ChkTeX does not append a record separator to a custom -f format. Without
// this newline, consecutive diagnostics run together and only the first one
// survives parseChktexOutput().
const outputFormat = "%f|%l|%c|%d|%n|%m\n";

interface LaneSequence {
  sequence: number;
  key: string;
  seenAt: number;
}

export class ChktexUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChktexUnavailableError";
  }
}

/** A newer idle revision replaced a check which had not started yet. */
export class ChktexLintSupersededError extends Error {
  constructor() {
    super("A newer ChkTeX check replaced this request.");
    this.name = "ChktexLintSupersededError";
  }
}

/**
 * Parse ChkTeX's machine-readable format.  Only the first five separators
 * have meaning, so a `|` in the human message is preserved rather than
 * making the whole result invalid.
 */
export function parseChktexOutput(output: string): RawChktexLint[] {
  const lints: RawChktexLint[] = [];
  const seen = new Set<string>();
  for (const line of output.split(/\r?\n/u)) {
    const match = /^([^|]*)\|(\d+)\|(\d+)\|(-?\d+)\|(\d+)\|(.*)$/u.exec(line);
    if (!match) continue;
    const lineNumber = Number(match[2]);
    const column = Number(match[3]);
    const length = Math.max(1, Number(match[4]));
    const number = Number(match[5]);
    const message = match[6].trim();
    if (!Number.isSafeInteger(lineNumber) || lineNumber < 1 || !Number.isSafeInteger(column) || column < 1 || !message) continue;
    const key = `${lineNumber}:${column}:${length}:${number}:${message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    lints.push({ line: lineNumber, column, length, number: Number.isSafeInteger(number) ? number : null, message });
  }
  return lints;
}

function cacheKey(source: string, filePath: string): string {
  return createHash("sha256").update(filePath.toLowerCase()).update("\0").update(source).digest("base64url");
}

/**
 * Optional host-side ChkTeX integration.  ChkTeX is intentionally run as a
 * bounded, process-wide queue: at most eight projects/users consume a checker
 * process at once, and a newer revision replaces obsolete waiting work in its
 * own browser lane.  The caller still debounces edits; this is the server-side
 * backstop for multiple tabs and collaborators.
 */
export class ChktexService {
  private availability: "unknown" | "available" | "unavailable" = "unknown";
  private lastUnavailableAt = 0;
  private probePromise: Promise<void> | null = null;
  private readonly queued = new Set<ScheduledCheck>();
  private readonly waitingByLane = new Map<string, ScheduledCheck>();
  private readonly latestSequenceByLane = new Map<string, LaneSequence>();
  private readonly inFlight = new Map<string, Promise<RawChktexLint[]>>();
  private readonly scheduledByKey = new Map<string, ScheduledCheck>();
  private readonly cache = new Map<string, CachedResult>();
  private readonly activeChildren = new Set<ChildProcess>();
  private readonly activeOperations = new Set<Promise<void>>();
  private activeCount = 0;
  private disposed = false;

  constructor(private readonly command = "chktex") {}

  async preload(): Promise<void> {
    await this.ensureAvailable();
  }

  async lint(source: string, filePath = "main.tex", lane?: string, sequence?: number): Promise<RawChktexLint[]> {
    if (this.disposed) throw new ChktexUnavailableError("ChkTeX service stopped.");
    const key = cacheKey(source, filePath);
    const laneKey = lane || null;
    if (laneKey && sequence !== undefined) this.acceptLaneSequence(laneKey, sequence, key);
    const waiting = laneKey ? this.waitingByLane.get(laneKey) : undefined;
    if (waiting?.key === key) return waiting.promise;
    if (laneKey && waiting) this.releaseWaitingLane(laneKey, waiting);
    const cacheable = Buffer.byteLength(source, "utf8") <= maxCachedSourceBytes;
    if (cacheable) {
      const cached = this.cachedResult(key);
      if (cached) return cached;
    }
    const existing = this.inFlight.get(key);
    if (existing) {
      const scheduled = this.scheduledByKey.get(key);
      if (laneKey && scheduled) this.addWaitingLane(scheduled, laneKey);
      else if (scheduled && !scheduled.started) scheduled.hasUnscopedWaiter = true;
      return existing;
    }

    let resolve!: (lints: RawChktexLint[]) => void;
    let reject!: (error: unknown) => void;
    const operation = new Promise<RawChktexLint[]>((resolveOperation, rejectOperation) => {
      resolve = resolveOperation;
      reject = rejectOperation;
    });
    const scheduled: ScheduledCheck = {
      key, source, filePath, started: false, cancelled: false,
      lanes: laneKey ? new Set([laneKey]) : new Set(), hasUnscopedWaiter: laneKey === null,
      promise: operation, resolve, reject
    };
    this.inFlight.set(key, operation);
    this.scheduledByKey.set(key, scheduled);
    if (laneKey) this.waitingByLane.set(laneKey, scheduled);
    this.queued.add(scheduled);
    this.drain();
    void operation.then(
      (lints) => { if (cacheable) this.cacheResult(key, lints); },
      () => undefined
    ).finally(() => {
      if (this.inFlight.get(key) === operation) this.inFlight.delete(key);
      if (this.scheduledByKey.get(key) === scheduled) this.scheduledByKey.delete(key);
    });
    return operation;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    const stopped = new ChktexUnavailableError("ChkTeX service stopped.");
    for (const scheduled of [...this.queued]) {
      if (scheduled.started || scheduled.cancelled) continue;
      scheduled.cancelled = true;
      this.discardQueued(scheduled);
      scheduled.reject(stopped);
    }
    this.waitingByLane.clear();
    this.latestSequenceByLane.clear();
    for (const child of this.activeChildren) killProcessGroup(child, "SIGTERM");
    await Promise.allSettled([...this.activeOperations]);
    await this.probePromise?.catch(() => undefined);
    this.inFlight.clear();
    this.scheduledByKey.clear();
    this.cache.clear();
  }

  private addWaitingLane(scheduled: ScheduledCheck, lane: string): void {
    if (scheduled.started || scheduled.cancelled) return;
    scheduled.lanes.add(lane);
    this.waitingByLane.set(lane, scheduled);
  }

  private releaseWaitingLane(lane: string, scheduled: ScheduledCheck): void {
    if (this.waitingByLane.get(lane) === scheduled) this.waitingByLane.delete(lane);
    scheduled.lanes.delete(lane);
    if (scheduled.started || scheduled.cancelled || scheduled.hasUnscopedWaiter || scheduled.lanes.size > 0) return;
    this.cancelScheduled(scheduled);
  }

  private cancelScheduled(scheduled: ScheduledCheck): void {
    if (scheduled.started || scheduled.cancelled) return;
    scheduled.cancelled = true;
    for (const lane of scheduled.lanes) if (this.waitingByLane.get(lane) === scheduled) this.waitingByLane.delete(lane);
    scheduled.lanes.clear();
    if (this.inFlight.get(scheduled.key) === scheduled.promise) this.inFlight.delete(scheduled.key);
    if (this.scheduledByKey.get(scheduled.key) === scheduled) this.scheduledByKey.delete(scheduled.key);
    this.discardQueued(scheduled);
    scheduled.reject(new ChktexLintSupersededError());
  }

  private discardQueued(scheduled: ScheduledCheck): void {
    this.queued.delete(scheduled);
    scheduled.source = "";
    scheduled.filePath = "";
  }

  private acceptLaneSequence(lane: string, sequence: number, key: string): void {
    if (!Number.isSafeInteger(sequence) || sequence <= 0) throw new ChktexLintSupersededError();
    const now = Date.now();
    for (const [knownLane, state] of this.latestSequenceByLane) {
      if (now - state.seenAt > laneSequenceRetentionMs) this.latestSequenceByLane.delete(knownLane);
    }
    const previous = this.latestSequenceByLane.get(lane);
    if (previous && (sequence < previous.sequence || (sequence === previous.sequence && previous.key !== key))) {
      throw new ChktexLintSupersededError();
    }
    this.latestSequenceByLane.delete(lane);
    this.latestSequenceByLane.set(lane, { sequence, key, seenAt: now });
    while (this.latestSequenceByLane.size > maxTrackedLaneSequences) {
      const oldest = this.latestSequenceByLane.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.latestSequenceByLane.delete(oldest);
    }
  }

  private drain(): void {
    while (!this.disposed && this.activeCount < maxConcurrency) {
      const scheduled = this.queued.values().next().value as ScheduledCheck | undefined;
      if (!scheduled) return;
      this.queued.delete(scheduled);
      if (scheduled.cancelled) continue;
      scheduled.started = true;
      for (const lane of scheduled.lanes) if (this.waitingByLane.get(lane) === scheduled) this.waitingByLane.delete(lane);
      scheduled.lanes.clear();
      this.activeCount += 1;
      let operation!: Promise<void>;
      operation = this.runScheduled(scheduled).finally(() => {
        this.activeCount -= 1;
        this.activeOperations.delete(operation);
        this.drain();
      });
      this.activeOperations.add(operation);
    }
  }

  private async runScheduled(scheduled: ScheduledCheck): Promise<void> {
    try {
      scheduled.resolve(await this.lintOnce(scheduled.source, scheduled.filePath));
    } catch (error) {
      scheduled.reject(error);
    }
  }

  private async ensureAvailable(): Promise<void> {
    if (this.disposed) throw new ChktexUnavailableError("ChkTeX service stopped.");
    if (this.availability === "available") return;
    if (this.availability === "unavailable" && Date.now() - this.lastUnavailableAt < unavailableRetryMs) {
      throw new ChktexUnavailableError(`The optional ${this.command} command is not available.`);
    }
    if (this.probePromise) return this.probePromise;
    this.probePromise = this.runCommand(["--version"], "", commandProbeTimeoutMs, 64 * 1024)
      .then(({ code, stdout, stderr }) => {
        if (code !== 0) throw new Error((stderr || stdout).trim() || `${this.command} exited with code ${code}`);
        this.availability = "available";
      })
      .catch((error) => {
        this.availability = "unavailable";
        this.lastUnavailableAt = Date.now();
        const detail = error instanceof Error ? error.message : String(error);
        throw new ChktexUnavailableError(`The optional ${this.command} command is unavailable: ${detail}`);
      })
      .finally(() => { this.probePromise = null; });
    return this.probePromise;
  }

  private async lintOnce(source: string, filePath: string): Promise<RawChktexLint[]> {
    await this.ensureAvailable();
    // With no filename ChkTeX reads stdin. Passing `-` is interpreted as a
    // literal filename by ChkTeX 1.7.x and silently produces no diagnostics.
    // Only the active editor buffer is submitted. Disable ChkTeX's recursive
    // \input traversal so diagnostics from another file cannot be mapped onto
    // this buffer's line and column numbers.
    const result = await this.runCommand(["-q", "-I0", "-f", outputFormat], source, checkTimeoutMs, maxOutputBytes);
    // ChkTeX commonly exits with 2 when it found warnings. Some packaged
    // releases use 1 for the same condition, so a structured diagnostic also
    // makes either status successful; a non-zero status without diagnostics is
    // still an execution failure.
    const lints = parseChktexOutput(result.stdout);
    const expectedDiagnosticExit = (result.code === 1 || result.code === 2) && lints.length > 0;
    if (result.code !== 0 && !expectedDiagnosticExit) {
      const detail = result.stderr.trim() || result.stdout.trim();
      throw new Error(detail || `${this.command} exited with code ${result.code}`);
    }
    return lints;
  }

  private cachedResult(key: string): RawChktexLint[] | null {
    const cached = this.cache.get(key);
    if (!cached || cached.expiresAt < Date.now()) {
      this.cache.delete(key);
      return null;
    }
    this.cache.delete(key);
    this.cache.set(key, cached);
    return cached.lints;
  }

  private cacheResult(key: string, lints: RawChktexLint[]): void {
    this.cache.set(key, { expiresAt: Date.now() + cacheTtlMs, lints });
    while (this.cache.size > maxCachedResults) {
      const oldest = this.cache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }

  private runCommand(args: string[], input: string, timeoutMs: number, outputLimit: number): Promise<{ code: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      if (this.disposed) {
        reject(new ChktexUnavailableError("ChkTeX service stopped."));
        return;
      }
      let child: ChildProcess;
      try {
        child = spawn(this.command, args, {
          env: { ...process.env, LC_ALL: "C" }, shell: false, detached: detachedProcessGroup(),
          stdio: ["pipe", "pipe", "pipe"]
        });
      } catch (error) {
        reject(error);
        return;
      }
      this.activeChildren.add(child);
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let outputBytes = 0;
      let settled = false;
      let timedOut = false;
      const finish = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.activeChildren.delete(child);
        callback();
      };
      const terminate = (error: Error): void => {
        killProcessGroup(child);
        finish(() => reject(error));
      };
      const timer = setTimeout(() => {
        timedOut = true;
        killProcessGroup(child);
      }, timeoutMs);
      const collect = (target: Buffer[]) => (chunk: Buffer): void => {
        outputBytes += chunk.length;
        if (outputBytes > outputLimit) {
          terminate(new Error(`${this.command} produced too much output.`));
          return;
        }
        target.push(chunk);
      };
      child.stdout?.on("data", collect(stdout));
      child.stderr?.on("data", collect(stderr));
      child.stdin?.on("error", (error) => terminate(error));
      child.once("error", (error) => finish(() => {
        if (timedOut) return reject(new Error(`${this.command} timed out after ${Math.ceil(timeoutMs / 1000)} seconds.`));
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return reject(new ChktexUnavailableError(`The optional ${this.command} command is not available.`));
        reject(error);
      }));
      child.once("close", (code) => finish(() => {
        if (timedOut) return reject(new Error(`${this.command} timed out after ${Math.ceil(timeoutMs / 1000)} seconds.`));
        resolve({ code, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") });
      }));
      child.stdin?.end(input);
    });
  }
}
