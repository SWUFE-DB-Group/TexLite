import { getDocument, GlobalWorkerOptions, PDFWorker, version, type PDFDocumentLoadingTask, type PDFDocumentProxy } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { appPath } from "./basePath";

GlobalWorkerOptions.workerSrc = workerUrl;
const sharedPdfWorker = new PDFWorker();
const MAX_RETAINED_PDF_DOCUMENTS = 2;
export type PdfLoadingMode = "full" | "range";

interface CachedPdfDocument {
  task: PDFDocumentLoadingTask;
  promise: Promise<PDFDocumentProxy>;
  consumers: number;
  settled: boolean;
  retired: boolean;
  lastUsed: number;
}

export interface PdfDocumentLease {
  promise: Promise<PDFDocumentProxy>;
  release: () => void;
}

const cachedPdfDocuments = new Map<string, CachedPdfDocument>();

/** Initialize the shared worker without fetching a project PDF. */
export async function preloadPdfRuntime(): Promise<void> {
  await sharedPdfWorker.promise;
}

function pdfDocument(url: string, loadingMode: PdfLoadingMode): CachedPdfDocument {
  const cacheKey = `${loadingMode}:${url}`;
  const cached = cachedPdfDocuments.get(cacheKey);
  if (cached) {
    cached.lastUsed = Date.now();
    return cached;
  }
  const task = getDocument({
    url,
    worker: sharedPdfWorker,
    disableRange: loadingMode === "full",
    cMapUrl: new URL(appPath(`/assets/pdfjs-${version}/cmaps/`), window.location.origin).href,
    cMapPacked: true
  });
  const entry: CachedPdfDocument = {
    task, promise: task.promise, consumers: 0, settled: false, retired: false, lastUsed: Date.now()
  };
  cachedPdfDocuments.set(cacheKey, entry);
  void entry.promise.then(() => {
    entry.settled = true;
    prunePdfDocuments();
  }, () => {
    entry.settled = true;
    if (cachedPdfDocuments.get(cacheKey) === entry) cachedPdfDocuments.delete(cacheKey);
    if (!entry.retired) {
      entry.retired = true;
      if (entry.consumers === 0) void entry.task.destroy();
    }
  });
  return entry;
}

export function evictPdfDocument(url: string, loadingMode: PdfLoadingMode): void {
  const cacheKey = `${loadingMode}:${url}`;
  const entry = cachedPdfDocuments.get(cacheKey);
  if (!entry) return;
  cachedPdfDocuments.delete(cacheKey);
  entry.retired = true;
  if (entry.consumers === 0) void entry.task.destroy();
}

function prunePdfDocuments(): void {
  if (cachedPdfDocuments.size <= MAX_RETAINED_PDF_DOCUMENTS) return;
  const candidates = [...cachedPdfDocuments.entries()]
    .filter(([, entry]) => entry.consumers === 0 && entry.settled)
    .sort((left, right) => left[1].lastUsed - right[1].lastUsed);
  while (cachedPdfDocuments.size > MAX_RETAINED_PDF_DOCUMENTS && candidates.length) {
    const [key, entry] = candidates.shift()!;
    if (cachedPdfDocuments.get(key) !== entry) continue;
    cachedPdfDocuments.delete(key);
    entry.retired = true;
    void entry.task.destroy();
  }
}

/** Start loading an immutable PDF; the viewer subsequently acquires the same task. */
export function preloadPdf(url: string, loadingMode: PdfLoadingMode): void {
  if (url) void pdfDocument(url, loadingMode).promise.catch(() => undefined);
}

/** Viewers own leases, not the shared document or worker lifetime. */
export function acquirePdfDocument(url: string, loadingMode: PdfLoadingMode): PdfDocumentLease {
  const entry = pdfDocument(url, loadingMode);
  entry.consumers += 1;
  entry.lastUsed = Date.now();
  let released = false;
  return {
    promise: entry.promise,
    release: () => {
      if (released) return;
      released = true;
      entry.consumers = Math.max(0, entry.consumers - 1);
      entry.lastUsed = Date.now();
      if (entry.retired && entry.consumers === 0) void entry.task.destroy();
      prunePdfDocuments();
    }
  };
}
