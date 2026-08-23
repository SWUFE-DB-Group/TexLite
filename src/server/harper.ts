import { Worker } from "node:worker_threads";
import type { Linter } from "harper.js";
import type { RawHarperLint } from "./harperRuntime.js";

export type { RawHarperLint } from "./harperRuntime.js";

const setupTimeoutMs = 45_000;
const lintTimeoutMs = 30_000;

type WorkerResponse =
  | { type: "ready" }
  | { type: "load-error"; message: string }
  | { id: number; ok: true; lints: RawHarperLint[] }
  | { id: number; ok: false; message: string };

function withTimeout<T>(operation: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    operation.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); }
    );
  });
}

/**
 * One Harper runtime per TexLite server process. Production uses one Node
 * Worker so WASM checks cannot block Fastify or collaboration messages. Source
 * mode (tsx/Vitest) uses the same runtime in-process because the emitted worker
 * entry does not exist until the server build has completed.
 */
export class HarperService {
  private readonly useWorker = import.meta.url.endsWith(".js");
  private linter: Linter | null = null;
  private setupPromise: Promise<void> | null = null;
  private worker: Worker | null = null;
  private nextRequestId = 1;
  private pending = new Map<number, { resolve: (lints: RawHarperLint[]) => void; reject: (error: Error) => void }>();
  private queue: Promise<void> = Promise.resolve();

  async preload(): Promise<void> {
    await this.ensureRuntime();
  }

  async lint(source: string): Promise<RawHarperLint[]> {
    const operation = this.queue.then(async () => {
      await this.ensureRuntime();
      try {
        return await withTimeout(this.useWorker ? this.lintInWorker(source) : this.lintInProcess(source), lintTimeoutMs, "Harper writing check timed out.");
      } catch (error) {
        if (error instanceof Error && error.message === "Harper writing check timed out.") this.stopFailedWorker(error);
        throw error;
      }
    });
    this.queue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async dispose(): Promise<void> {
    await this.queue.catch(() => undefined);
    await this.setupPromise?.catch(() => undefined);
    const worker = this.worker;
    this.worker = null;
    if (worker) await worker.terminate().catch(() => undefined);
    const linter = this.linter;
    this.linter = null;
    if (linter) await linter.dispose().catch(() => undefined);
    this.setupPromise = null;
    this.rejectPending(new Error("Harper service stopped."));
  }

  private ensureRuntime(): Promise<void> {
    if (this.setupPromise) return this.setupPromise;
    if (this.worker || this.linter) return Promise.resolve();
    this.setupPromise = withTimeout(this.useWorker ? this.startWorker() : this.startInProcess(), setupTimeoutMs, "Harper initialization timed out.")
      .catch((error) => {
        this.stopFailedWorker(error instanceof Error ? error : new Error(String(error)));
        throw error;
      })
      .finally(() => { this.setupPromise = null; });
    return this.setupPromise;
  }

  private async startInProcess(): Promise<void> {
    const { createHarperLinter } = await import("./harperRuntime.js");
    this.linter = await createHarperLinter();
  }

  private startWorker(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const worker = new Worker(new URL("./harperWorker.js", import.meta.url), { name: "texlite-harper" });
      this.worker = worker;
      const rejectStart = (error: Error) => reject(error);
      const onInitialMessage = (message: WorkerResponse) => {
        if (!("type" in message)) return;
        worker.off("message", onInitialMessage);
        worker.off("error", rejectStart);
        if (message.type === "ready") resolve();
        else reject(new Error(message.message));
      };
      worker.on("message", onInitialMessage);
      worker.once("error", rejectStart);
      worker.on("message", (message: WorkerResponse) => this.handleWorkerMessage(message));
      worker.on("error", (error) => this.stopFailedWorker(error));
      worker.on("exit", (code) => {
        if (this.worker !== worker) return;
        this.worker = null;
        this.rejectPending(new Error(`Harper worker exited unexpectedly with code ${code}.`));
      });
    });
  }

  private lintInWorker(source: string): Promise<RawHarperLint[]> {
    const worker = this.worker;
    if (!worker) return Promise.reject(new Error("Harper worker is not ready."));
    const id = this.nextRequestId++;
    return new Promise<RawHarperLint[]>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      worker.postMessage({ id, source });
    });
  }

  private async lintInProcess(source: string): Promise<RawHarperLint[]> {
    if (!this.linter) throw new Error("Harper is not ready.");
    const { collectHarperLints } = await import("./harperRuntime.js");
    return collectHarperLints(this.linter, source);
  }

  private handleWorkerMessage(message: WorkerResponse): void {
    if ("type" in message) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.ok) pending.resolve(message.lints);
    else pending.reject(new Error(message.message));
  }

  private stopFailedWorker(error: Error): void {
    const worker = this.worker;
    this.worker = null;
    if (worker) void worker.terminate().catch(() => undefined);
    const linter = this.linter;
    this.linter = null;
    if (linter) void linter.dispose().catch(() => undefined);
    this.rejectPending(error);
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}
