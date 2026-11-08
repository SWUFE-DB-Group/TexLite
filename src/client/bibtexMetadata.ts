import type { BibtexEntrySummary } from "./bibtex/entryMetadata";
import type {
  BibtexMetadataFailureKind,
  BibtexMetadataWorkerRequest,
  BibtexMetadataWorkerResponse
} from "./bibtexMetadataProtocol";

/** Time one parse may take once the worker has received it. */
const REQUEST_TIMEOUT_MS = 30_000;

interface MetadataRequest {
  id: number;
  source: string;
  resolve: (entries: BibtexEntrySummary[]) => void;
  reject: (error: BibtexMetadataError) => void;
}

export class BibtexMetadataError extends Error {
  constructor(readonly kind: BibtexMetadataFailureKind) {
    super(`BibTeX metadata: ${kind}`);
    this.name = "BibtexMetadataError";
  }
}

/*
 * Requests are sent to the worker one at a time. The worker parses serially
 * anyway, so this costs nothing, and it makes each timeout measure only its own
 * parse: a large file that times out terminates the worker and fails alone,
 * while the requests queued behind it continue on a fresh worker.
 */
let worker: Worker | null = null;
let nextRequestId = 1;
const queue: MetadataRequest[] = [];
let active: { request: MetadataRequest; timeout: ReturnType<typeof setTimeout> } | null = null;

function terminateWorker(): void {
  const current = worker;
  worker = null;
  current?.terminate();
}

function finishActive(): MetadataRequest | null {
  const current = active;
  active = null;
  if (!current) return null;
  clearTimeout(current.timeout);
  return current.request;
}

/** Fail the request in flight, optionally discarding its worker, and move on. */
function failActive(kind: BibtexMetadataFailureKind, discardWorker: boolean): void {
  const request = finishActive();
  if (discardWorker) terminateWorker();
  request?.reject(new BibtexMetadataError(kind));
  pump();
}

function validEntries(value: unknown): value is BibtexEntrySummary[] {
  return Array.isArray(value) && value.every((entry) => {
    if (!entry || typeof entry !== "object") return false;
    const record = entry as Record<string, unknown>;
    return typeof record.key === "string" && typeof record.entryType === "string"
      && ["title", "authors", "year", "venue", "doi", "url"].every((field) =>
        record[field] === null || typeof record[field] === "string");
  });
}

function failureKind(value: unknown): BibtexMetadataFailureKind {
  return value === "invalid" || value === "timeout" || value === "unavailable" ? value : "unavailable";
}

function getWorker(): Worker {
  if (worker) return worker;
  if (typeof Worker === "undefined") throw new BibtexMetadataError("unavailable");
  const current = new Worker(new URL("./bibtexMetadataWorker.ts", import.meta.url), {
    type: "module", name: "texlite-bibtex-metadata"
  });
  worker = current;
  current.onmessage = ({ data }: MessageEvent<BibtexMetadataWorkerResponse>) => {
    if (worker !== current) return;
    if (!data || typeof data.id !== "number" || typeof data.ok !== "boolean") {
      failActive("unavailable", true);
      return;
    }
    if (data.id !== active?.request.id) return;
    if (data.ok && !validEntries(data.entries)) {
      failActive("unavailable", true);
      return;
    }
    const request = finishActive()!;
    if (data.ok) request.resolve(data.entries);
    else request.reject(new BibtexMetadataError(failureKind(data.kind)));
    pump();
  };
  current.onerror = current.onmessageerror = () => {
    if (worker === current) failActive("unavailable", true);
  };
  return current;
}

function pump(): void {
  if (active || !queue.length) return;
  let current: Worker;
  try {
    current = getWorker();
  } catch {
    // No worker can be created, so nothing queued can run.
    for (const request of queue.splice(0)) request.reject(new BibtexMetadataError("unavailable"));
    return;
  }
  const request = queue.shift()!;
  active = { request, timeout: setTimeout(() => failActive("timeout", true), REQUEST_TIMEOUT_MS) };
  try {
    current.postMessage({ id: request.id, source: request.source } satisfies BibtexMetadataWorkerRequest);
  } catch {
    failActive("unavailable", true);
  }
}

export function parseBibtexMetadataInWorker(source: string): Promise<BibtexEntrySummary[]> {
  return new Promise((resolve, reject) => {
    queue.push({ id: nextRequestId++, source, resolve, reject });
    pump();
  });
}
