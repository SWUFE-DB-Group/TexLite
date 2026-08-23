const latexSourcePattern = /\.(?:tex|bib|cls|sty)$/i;

import { texFmtToolStatus } from "./clientToolStatus";
import type { LatexFormatterWorkerRequest, LatexFormatterWorkerResponse, LatexTextEdit, TexFmtFailureKind, TexFmtResult } from "./latexFormatterProtocol";

export type { LatexTextEdit, TexFmtFailureKind, TexFmtResult } from "./latexFormatterProtocol";

const FORMATTER_WORKER_TIMEOUT_MS = 30_000;
type LatexFormatterWorkerPayload =
  | Omit<Extract<LatexFormatterWorkerRequest, { action: "probe" }>, "id">
  | Omit<Extract<LatexFormatterWorkerRequest, { action: "format" }>, "id">
  | Omit<Extract<LatexFormatterWorkerRequest, { action: "diff" }>, "id">;
let formatterWorker: Worker | null = null;
let formatterWorkerReady = false;
let formatterWorkerLoadTimeout: number | null = null;
let nextRequestId = 1;
const pendingRequests = new Map<number, {
  request: LatexFormatterWorkerPayload;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timeout: number | null;
}>();
const formatterRequestQueue: number[] = [];
let activeRequestId: number | null = null;
let formatterPreload: Promise<void> | null = null;

export class TexFmtError extends Error {
  constructor(public readonly kind: TexFmtFailureKind, message: string) {
    super(message);
    this.name = "TexFmtError";
  }
}

export function isTexFmtError(error: unknown): error is TexFmtError {
  return error instanceof TexFmtError;
}

function stopFormatterWorker(error: TexFmtError): void {
  formatterWorker?.terminate();
  formatterWorker = null;
  formatterWorkerReady = false;
  if (formatterWorkerLoadTimeout !== null) window.clearTimeout(formatterWorkerLoadTimeout);
  formatterWorkerLoadTimeout = null;
  activeRequestId = null;
  formatterRequestQueue.length = 0;
  formatterPreload = null;
  texFmtToolStatus.failed(error);
  for (const pending of pendingRequests.values()) {
    if (pending.timeout !== null) window.clearTimeout(pending.timeout);
    pending.reject(error);
  }
  pendingRequests.clear();
}

function runNextFormatterRequest(): void {
  if (activeRequestId !== null) return;
  if (formatterRequestQueue.length === 0) return;
  let worker: Worker;
  try {
    worker = getFormatterWorker();
  } catch (error) {
    stopFormatterWorker(error instanceof TexFmtError ? error : new TexFmtError("load", "The bundled tex-fmt formatter could not be loaded."));
    return;
  }
  if (!formatterWorkerReady) return;
  const id = formatterRequestQueue.shift();
  if (id === undefined) return;
  const pending = pendingRequests.get(id);
  if (!pending) {
    runNextFormatterRequest();
    return;
  }
  activeRequestId = id;
  pending.timeout = window.setTimeout(() => {
    if (activeRequestId !== id) return;
    stopFormatterWorker(new TexFmtError("result", "The formatter did not respond within 30 seconds."));
  }, FORMATTER_WORKER_TIMEOUT_MS);
  try {
    worker.postMessage({ ...pending.request, id } as LatexFormatterWorkerRequest);
  } catch {
    stopFormatterWorker(new TexFmtError("load", "The formatter worker could not receive the source."));
  }
}

function getFormatterWorker(): Worker {
  if (formatterWorker) return formatterWorker;
  if (typeof Worker === "undefined") {
    const error = new TexFmtError("load", "This browser does not support formatter workers.");
    texFmtToolStatus.failed(error);
    throw error;
  }
  texFmtToolStatus.loading();
  try {
    formatterWorker = new Worker(new URL("./latexFormatterWorker.ts", import.meta.url), {
      type: "module",
      name: "texlite-latex-formatter"
    });
    formatterWorkerLoadTimeout = window.setTimeout(() => {
      if (formatterWorkerReady) return;
      stopFormatterWorker(new TexFmtError("load", "The formatter did not finish loading within 30 seconds."));
    }, FORMATTER_WORKER_TIMEOUT_MS);
  } catch {
    const error = new TexFmtError("load", "The bundled tex-fmt formatter could not be loaded.");
    texFmtToolStatus.failed(error);
    throw error;
  }
  formatterWorker.onmessage = (event: MessageEvent<LatexFormatterWorkerResponse>) => {
    const response = event.data;
    if (response && "type" in response) {
      if (response.type === "ready") {
        formatterWorkerReady = true;
        if (formatterWorkerLoadTimeout !== null) window.clearTimeout(formatterWorkerLoadTimeout);
        formatterWorkerLoadTimeout = null;
        runNextFormatterRequest();
      }
      return;
    }
    if (!response || typeof response.id !== "number") {
      stopFormatterWorker(new TexFmtError("result", "The formatter worker returned an invalid response."));
      return;
    }
    const pending = pendingRequests.get(response.id);
    if (!pending) return;
    pendingRequests.delete(response.id);
    if (pending.timeout !== null) window.clearTimeout(pending.timeout);
    if (activeRequestId === response.id) activeRequestId = null;
    if (response.ok) {
      texFmtToolStatus.working();
      pending.resolve(response.result);
      runNextFormatterRequest();
    } else {
      const error = new TexFmtError(response.kind, response.message);
      // Invalid source or TOML options do not mean the package failed to load.
      if (response.kind === "format") {
        texFmtToolStatus.working();
        pending.reject(error);
        runNextFormatterRequest();
      } else {
        pending.reject(error);
        stopFormatterWorker(error);
      }
    }
  };
  formatterWorker.onerror = () => {
    stopFormatterWorker(new TexFmtError("load", "The bundled tex-fmt formatter could not be loaded."));
  };
  formatterWorker.onmessageerror = () => {
    stopFormatterWorker(new TexFmtError("result", "The formatter worker returned an unreadable response."));
  };
  return formatterWorker;
}

function requestFormatterWorker<T>(request: LatexFormatterWorkerPayload): Promise<T> {
  const id = nextRequestId++;
  return new Promise<T>((resolve, reject) => {
    pendingRequests.set(id, { request, resolve: resolve as (value: unknown) => void, reject, timeout: null });
    formatterRequestQueue.push(id);
    runNextFormatterRequest();
  });
}

/**
 * Format LaTeX source in the browser with the bundled tex-fmt WASM build.
 *
 * The module is loaded lazily so opening a project does not pay for the
 * formatter unless the user formats a file (or enables format-before-compile).
 * `config` is the TOML options string accepted by tex-fmt and is deliberately
 * supplied by the caller so editor preferences can remain user/project local.
 */
export function formatWithTexFmt(source: string, config = ""): Promise<TexFmtResult> {
  return requestFormatterWorker<TexFmtResult>({ action: "format", source, config });
}

/** Load the formatter Worker and verify that its WASM runtime is callable. */
export async function preloadTexFmt(): Promise<void> {
  if (formatterWorker && texFmtToolStatus.getSnapshot().status === "working") return;
  if (!formatterPreload) {
    formatterPreload = requestFormatterWorker<true>({ action: "probe" })
      .then(() => undefined)
      .finally(() => { formatterPreload = null; });
  }
  await formatterPreload;
}

/** Discard a failed formatter runtime and retry its Worker/WASM initialization. */
export async function reloadTexFmt(): Promise<void> {
  if (formatterWorker || pendingRequests.size) {
    stopFormatterWorker(new TexFmtError("load", "The formatter runtime was reloaded."));
  }
  texFmtToolStatus.loading();
  await preloadTexFmt();
}

export function isFormattableLatexFile(filePath: string): boolean {
  return latexSourcePattern.test(filePath);
}

function trailingLineBreaks(source: string): string {
  return source.match(/(?:\r?\n)+$/)?.[0] ?? "";
}

/**
 * Put formatted selection text back at the indentation level from which it
 * was selected. Formatters generally format from column zero, while a
 * selection inside an environment should remain nested in the document.
 */
export function reindentLatexSelection(source: string, formatted: string): string {
  const trailing = trailingLineBreaks(source);
  const body = trailing ? source.slice(0, -trailing.length) : source;
  const lines = body.split(/\r?\n/);
  const firstContentLine = lines.find((line) => line.trim());
  const baseIndent = firstContentLine?.match(/^[\t ]*/)?.[0] ?? "";
  const normalized = formatted.replace(/(?:\r?\n)+$/, "");
  const reindented = baseIndent
    ? normalized.split("\n").map((line) => line ? `${baseIndent}${line}` : line).join("\n")
    : normalized;
  return `${reindented}${trailing}`;
}

export async function createLatexTextEdits(source: string, formatted: string, baseOffset = 0): Promise<LatexTextEdit[]> {
  return requestFormatterWorker<LatexTextEdit[]>({ action: "diff", source, formatted, baseOffset });
}
