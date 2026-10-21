import type { BibtexFormatterFailureKind, BibtexFormatterWorkerRequest, BibtexFormatterWorkerResponse } from "./bibtexFormatterProtocol";
import type { LatexTextEdit } from "./latexFormatterProtocol";

type WorkerPayload =
  | Omit<Extract<BibtexFormatterWorkerRequest, { action: "format" }>, "id">
  | Omit<Extract<BibtexFormatterWorkerRequest, { action: "diff" }>, "id">;

let worker: Worker | null = null;
let nextRequestId = 1;
const pendingRequests = new Map<number, {
  action: WorkerPayload["action"];
  resolve: (result: unknown) => void;
  reject: (error: BibtexFormatterError) => void;
  timeout: ReturnType<typeof setTimeout>;
}>();

export class BibtexFormatterError extends Error {
  constructor(readonly kind: BibtexFormatterFailureKind) {
    super(`BibTeX formatter: ${kind}`);
    this.name = "BibtexFormatterError";
  }
}

function stopWorker(kind: "unavailable" | "timeout"): void {
  worker?.terminate();
  worker = null;
  for (const pending of pendingRequests.values()) {
    clearTimeout(pending.timeout);
    pending.reject(new BibtexFormatterError(kind));
  }
  pendingRequests.clear();
}

function getWorker(): Worker {
  if (worker) return worker;
  const current = new Worker(new URL("./bibtexFormatterWorker.ts", import.meta.url), {
    type: "module", name: "texlite-bibtex-formatter"
  });
  worker = current;
  current.onmessage = ({ data }: MessageEvent<BibtexFormatterWorkerResponse>) => {
    if (worker !== current) return;
    if (!data || typeof data.id !== "number" || typeof data.ok !== "boolean") {
      stopWorker("unavailable");
      return;
    }
    const pending = pendingRequests.get(data.id);
    if (!pending) return;
    if (data.ok && (data.action !== pending.action
      || (data.action === "format" ? typeof data.result !== "string" : !validTextEdits(data.result)))) {
      stopWorker("unavailable");
      return;
    }
    clearTimeout(pending.timeout);
    pendingRequests.delete(data.id);
    if (data.ok) pending.resolve(data.result);
    else if (data.kind === "too-large" || data.kind === "invalid") pending.reject(new BibtexFormatterError(data.kind));
    else {
      pending.reject(new BibtexFormatterError("unavailable"));
      stopWorker("unavailable");
    }
  };
  current.onerror = current.onmessageerror = () => {
    if (worker === current) stopWorker("unavailable");
  };
  return current;
}

function validTextEdits(value: unknown): value is LatexTextEdit[] {
  if (!Array.isArray(value)) return false;
  let previousEnd = 0;
  return value.every((edit) => {
    if (!edit || !Number.isSafeInteger(edit.from) || !Number.isSafeInteger(edit.to)
      || edit.from < previousEnd || edit.to < edit.from || typeof edit.replacement !== "string") return false;
    previousEnd = edit.to;
    return true;
  });
}

function requestWorker<T>(request: WorkerPayload): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let current: Worker;
    try { current = getWorker(); }
    catch { reject(new BibtexFormatterError("unavailable")); return; }
    const id = nextRequestId++;
    const timeout = setTimeout(() => stopWorker("timeout"), 30_000);
    pendingRequests.set(id, { action: request.action, resolve: resolve as (result: unknown) => void, reject, timeout });
    try { current.postMessage({ ...request, id } satisfies BibtexFormatterWorkerRequest); }
    catch { stopWorker("unavailable"); }
  });
}

/** Lazily reuse a separate Worker without loading tex-fmt or its WASM. */
export function formatBibtexInWorker(source: string, maxBytes: number): Promise<string> {
  return requestWorker<string>({ action: "format", source, maxBytes });
}

export function createBibtexTextEdits(source: string, formatted: string, baseOffset = 0): Promise<LatexTextEdit[]> {
  return requestWorker<LatexTextEdit[]>({ action: "diff", source, formatted, baseOffset });
}
