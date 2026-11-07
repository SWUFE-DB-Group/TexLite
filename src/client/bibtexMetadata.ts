import type { BibtexEntrySummary } from "./bibtex/entryMetadata";
import type {
  BibtexMetadataFailureKind,
  BibtexMetadataWorkerRequest,
  BibtexMetadataWorkerResponse
} from "./bibtexMetadataProtocol";

const REQUEST_TIMEOUT_MS = 30_000;

let worker: Worker | null = null;
let nextRequestId = 1;
const pending = new Map<number, {
  resolve: (entries: BibtexEntrySummary[]) => void;
  reject: (error: BibtexMetadataError) => void;
  timeout: ReturnType<typeof setTimeout>;
}>();

export class BibtexMetadataError extends Error {
  constructor(readonly kind: BibtexMetadataFailureKind) {
    super(`BibTeX metadata: ${kind}`);
    this.name = "BibtexMetadataError";
  }
}

function stopWorker(kind: BibtexMetadataFailureKind): void {
  const current = worker;
  worker = null;
  current?.terminate();
  for (const request of pending.values()) {
    clearTimeout(request.timeout);
    request.reject(new BibtexMetadataError(kind));
  }
  pending.clear();
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
      stopWorker("unavailable");
      return;
    }
    const request = pending.get(data.id);
    if (!request) return;
    if (data.ok && !validEntries(data.entries)) {
      stopWorker("unavailable");
      return;
    }
    clearTimeout(request.timeout);
    pending.delete(data.id);
    if (data.ok) request.resolve(data.entries);
    else request.reject(new BibtexMetadataError(failureKind(data.kind)));
  };
  current.onerror = current.onmessageerror = () => {
    if (worker === current) stopWorker("unavailable");
  };
  return current;
}

export function parseBibtexMetadataInWorker(source: string): Promise<BibtexEntrySummary[]> {
  return new Promise((resolve, reject) => {
    let current: Worker;
    try { current = getWorker(); }
    catch (error) { reject(error); return; }
    const id = nextRequestId++;
    const timeout = setTimeout(() => {
      if (!pending.has(id)) return;
      pending.delete(id);
      reject(new BibtexMetadataError("timeout"));
      stopWorker("timeout");
    }, REQUEST_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timeout });
    try {
      current.postMessage({ id, source } satisfies BibtexMetadataWorkerRequest);
    } catch {
      pending.delete(id);
      clearTimeout(timeout);
      reject(new BibtexMetadataError("unavailable"));
      stopWorker("unavailable");
    }
  });
}
