import type { Extension } from "@codemirror/state";
import { hoverTooltip, type Tooltip } from "@codemirror/view";
import type { LatexReference } from "../shared/latexReferences";
import { api } from "./api";
import type { BibtexEntrySummary } from "./bibtex/entryMetadata";
import { parseBibtexMetadataInWorker } from "./bibtexMetadata";
import { latexReferenceMarks } from "./latexReferenceMarks";

export interface CitationHoverLabels {
  loading: string;
  unavailable: string;
  inSource: string;
  untitled: string;
  doi: string;
  url: string;
  openHint: string;
  entry: (key: string) => string;
  notFound: (key: string) => string;
}

interface ResolvedCitationTarget {
  path: string;
  line: number;
  column: number;
  source: "label" | "bibitem" | "bibtex";
  /** Version of the file holding the definition; absent means "do not reuse". */
  revision?: string;
}

export interface CitationHoverTarget extends ResolvedCitationTarget {
  /** Parsed from the bibliography file in the browser when available. */
  citation?: BibtexEntrySummary | null;
}

interface CitationHoverOptions {
  projectId: string;
  filePath: string;
  mainFile: string;
  labels: CitationHoverLabels;
}

type CitationResolver = (reference: LatexReference, signal: AbortSignal) => Promise<CitationHoverTarget | null>;

const HOVER_TIME_MS = 600;
const MAX_FILE_CACHE_ENTRIES = 8;
/** A shared download that has not finished by then is abandoned. */
const DOWNLOAD_TIMEOUT_MS = 30_000;
/** How long a download nobody waits for is kept for a hover that may join it. */
const IDLE_DOWNLOAD_ABORT_MS = 10_000;

type ParsedBibFile = Map<string, BibtexEntrySummary>;

function abortError(): DOMException {
  return new DOMException("The operation was aborted", "AbortError");
}

/** Stop waiting for `promise` when `signal` aborts, without cancelling the work itself. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal, onAbort?: () => void): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const abort = () => {
      onAbort?.();
      reject(abortError());
    };
    signal.addEventListener("abort", abort, { once: true });
    promise.then((value) => {
      signal.removeEventListener("abort", abort);
      resolve(value);
    }, (error: unknown) => {
      signal.removeEventListener("abort", abort);
      reject(error);
    });
  });
}

export interface CitationFileCache {
  /**
   * Parsed entries of one project .bib file at a server-reported revision.
   * Concurrent callers share one fetch and parse; an empty revision is never
   * shared or cached. Rejects with an AbortError when `signal` aborts, but the
   * shared load keeps running for a while so a later hover can reuse it.
   */
  load(projectId: string, path: string, revision: string, signal: AbortSignal): Promise<ParsedBibFile>;
}

export interface CitationFileCacheOptions {
  maxEntries?: number;
  downloadTimeoutMs?: number;
  idleDownloadAbortMs?: number;
}

interface SharedLoad {
  revision: string;
  promise: Promise<ParsedBibFile>;
  join(signal: AbortSignal): Promise<ParsedBibFile>;
}

/**
 * Bounded, revision-checked cache of parsed .bib files. One instance is shared
 * by every resolver on the page, so remounting the editor for another file or
 * reconfiguring it after a preference change keeps the parsed bibliography.
 *
 * A shared load outlives the hover that started it, but its download never
 * hangs: it is aborted when it exceeds a deadline, or when no hover has been
 * waiting for it for a short grace period. Parsing is not aborted; the
 * metadata worker has its own timeout, and a finished parse fills the cache.
 */
export function createCitationFileCache({
  maxEntries = MAX_FILE_CACHE_ENTRIES,
  downloadTimeoutMs = DOWNLOAD_TIMEOUT_MS,
  idleDownloadAbortMs = IDLE_DOWNLOAD_ABORT_MS
}: CitationFileCacheOptions = {}): CitationFileCache {
  const parsed = new Map<string, { revision: string; entries: ParsedBibFile }>();
  const loading = new Map<string, SharedLoad>();

  const download = async (projectId: string, path: string, signal: AbortSignal): Promise<string> => {
    const result = await api<{ path: string; content: string }>(
      `/api/projects/${encodeURIComponent(projectId)}/file?path=${encodeURIComponent(path)}`, { signal }
    );
    if (signal.aborted) throw abortError();
    return result.content;
  };

  const parse = async (content: string): Promise<ParsedBibFile> => {
    const summaries = await parseBibtexMetadataInWorker(content);
    return new Map(summaries.map((entry) => [entry.key, entry]));
  };

  const remember = (key: string, revision: string, entries: ParsedBibFile) => {
    parsed.delete(key);
    parsed.set(key, { revision, entries });
    while (parsed.size > maxEntries) {
      const oldest = parsed.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      parsed.delete(oldest);
    }
  };

  const startSharedLoad = (key: string, projectId: string, path: string, revision: string): SharedLoad => {
    const controller = new AbortController();
    let downloading = true;
    let waiters = 0;
    let idleAbort: ReturnType<typeof setTimeout> | undefined;
    const deadline = setTimeout(() => controller.abort(), downloadTimeoutMs);
    const downloaded = download(projectId, path, controller.signal).finally(() => {
      downloading = false;
      clearTimeout(deadline);
      clearTimeout(idleAbort);
    });
    // The content is read after the revision was reported, so it is at least
    // as new as that revision: a later change makes the next lookup disagree
    // and reload. Only the newest load for a path may fill the cache, so an
    // older revision finishing late cannot replace it.
    const promise: Promise<ParsedBibFile> = downloaded.then(parse).then((entries) => {
      if (loading.get(key)?.promise === promise) {
        loading.delete(key);
        remember(key, revision, entries);
      }
      return entries;
    }, (error: unknown) => {
      if (loading.get(key)?.promise === promise) loading.delete(key);
      throw error;
    });
    // Waiters are hovers. When the last one leaves, give a hover moving to
    // another key a short window to join; only an unfinished download is
    // worth abandoning.
    const join = (signal: AbortSignal): Promise<ParsedBibFile> => {
      if (signal.aborted) return Promise.reject(abortError());
      waiters += 1;
      clearTimeout(idleAbort);
      let waiting = true;
      const release = () => {
        if (!waiting) return;
        waiting = false;
        waiters -= 1;
      };
      promise.then(release, release);
      return untilAborted(promise, signal, () => {
        release();
        if (waiters > 0 || !downloading) return;
        idleAbort = setTimeout(() => controller.abort(), idleDownloadAbortMs);
      });
    };
    return { revision, promise, join };
  };

  return {
    load(projectId, path, revision, signal) {
      if (!revision) {
        return untilAborted(download(projectId, path, signal).then(parse), signal);
      }
      const key = `${projectId}\0${path}`;
      const cached = parsed.get(key);
      if (cached?.revision === revision) {
        // Refresh recency so the file being used is evicted last.
        remember(key, revision, cached.entries);
        return Promise.resolve(cached.entries);
      }
      if (cached) parsed.delete(key);
      let current = loading.get(key);
      if (current?.revision !== revision) {
        current = startSharedLoad(key, projectId, path, revision);
        loading.set(key, current);
      }
      return current.join(signal);
    }
  };
}

const sharedFileCache = createCitationFileCache();

/**
 * Resolve a citation key to its target and, for a .bib target, its parsed entry.
 *
 * Every hover asks the server for the target: a consistent read that first
 * flushes live Yjs edits, so neither a newly added entry nor a changed line
 * number can be hidden by a stale answer, and a "not found" result is never
 * remembered. Only the expensive part, fetching and parsing a whole .bib file,
 * is reused, and only while the server reports the same file revision.
 * Rejects with an AbortError as soon as the signal aborts.
 */
export function createCitationResolver(
  options: Pick<CitationHoverOptions, "projectId" | "filePath" | "mainFile">,
  files: CitationFileCache = sharedFileCache
): CitationResolver {
  const project = `/api/projects/${encodeURIComponent(options.projectId)}`;

  const lookup = async (reference: LatexReference, signal: AbortSignal): Promise<ResolvedCitationTarget | null> => {
    const query = new URLSearchParams({ kind: "citation", key: reference.key });
    if (options.filePath) query.set("path", options.filePath);
    if (options.mainFile) query.set("mainFile", options.mainFile);
    const result = await api<{ target: ResolvedCitationTarget | null }>(
      `${project}/references/resolve?${query}`, { signal }
    );
    if (signal.aborted) throw abortError();
    return result.target;
  };

  return async (reference, signal) => {
    const target = await lookup(reference, signal);
    if (!target) return null;
    if (target.source !== "bibtex" || !/\.bib$/i.test(target.path)) return { ...target, citation: null };
    const entries = await files.load(options.projectId, target.path, target.revision ?? "", signal);
    return { ...target, citation: entries.get(reference.key) ?? null };
  };
}

/**
 * Preview a bibliography entry after a short stationary hover over a citation
 * key. The server resolves the same main-document-aware target as
 * Ctrl/Cmd-click navigation; the browser then parses the target .bib file in
 * the metadata worker. An obsolete request is aborted when its tooltip closes.
 */
export function latexCitationHover(options: CitationHoverOptions): Extension {
  const resolve = createCitationResolver(options);
  return hoverTooltip((view, position) => {
    const reference = view.plugin(latexReferenceMarks)?.citationAt(position);
    if (!reference) return null;
    return citationTooltip(reference, resolve, options.labels);
  }, { hoverTime: HOVER_TIME_MS, hideOnChange: true });
}

export function citationTooltip(
  reference: LatexReference,
  resolve: CitationResolver,
  labels: CitationHoverLabels
): Tooltip {
  let disposed = false;
  let controller: AbortController | null = null;
  return {
    pos: reference.from,
    end: reference.to,
    above: true,
    arrow: true,
    create() {
      controller = new AbortController();
      const dom = document.createElement("div");
      dom.className = "texlite-citation-hover";
      dom.setAttribute("role", "status");
      dom.setAttribute("aria-label", labels.entry(reference.key));
      appendMessage(dom, labels.loading, "muted");
      void resolve(reference, controller.signal).then((target) => {
        if (!disposed) renderCitationHover(dom, reference.key, target, labels);
      }).catch(() => {
        if (!disposed) renderCitationHover(dom, reference.key, undefined, labels);
      });
      return {
        dom,
        destroy() {
          disposed = true;
          controller?.abort();
        }
      };
    }
  };
}

/**
 * Render one tooltip state. `target === null` means the key was not found;
 * `undefined` means the lookup failed. Keeping this DOM-only makes the
 * presentation testable without a CodeMirror view.
 */
export function renderCitationHover(
  dom: HTMLDivElement,
  key: string,
  target: CitationHoverTarget | null | undefined,
  labels: CitationHoverLabels
): void {
  dom.replaceChildren();
  dom.setAttribute("aria-label", labels.entry(key));
  if (target === undefined) {
    appendMessage(dom, labels.unavailable, "error");
    return;
  }
  if (target === null) {
    appendMessage(dom, labels.notFound(key), "error");
    return;
  }

  const heading = document.createElement("div");
  heading.className = "texlite-citation-heading";
  const citationKey = document.createElement("code");
  citationKey.textContent = target.citation?.key ?? key;
  heading.append(citationKey);
  if (target.citation) {
    const entryType = document.createElement("span");
    entryType.textContent = `@${target.citation.entryType}`;
    heading.append(entryType);
  }
  dom.append(heading);

  if (!target.citation) {
    appendMessage(dom, target.source === "bibitem" ? labels.inSource : labels.unavailable, "muted");
  } else {
    const title = document.createElement("strong");
    title.className = "texlite-citation-title";
    title.textContent = target.citation.title ?? labels.untitled;
    dom.append(title);
    if (target.citation.authors) appendLine(dom, "texlite-citation-authors", target.citation.authors);
    const meta = [target.citation.venue, target.citation.year].filter(Boolean).join(" · ");
    if (meta) appendLine(dom, "texlite-citation-meta", meta);
    if (target.citation.doi) appendLine(dom, "texlite-citation-meta", `${labels.doi}: ${target.citation.doi}`);
    if (target.citation.url) appendLine(dom, "texlite-citation-meta texlite-citation-url", `${labels.url}: ${target.citation.url}`);
  }

  appendLine(dom, "texlite-citation-hint", labels.openHint);
  const source = document.createElement("div");
  source.className = "texlite-citation-source";
  source.textContent = `${target.path}:${target.line}`;
  source.title = target.path;
  dom.append(source);
}

function appendMessage(dom: HTMLDivElement, text: string, tone: "error" | "muted"): void {
  const message = document.createElement("div");
  message.className = `texlite-citation-message ${tone}`;
  message.textContent = text;
  dom.append(message);
}

function appendLine(dom: HTMLDivElement, className: string, text: string): void {
  const line = document.createElement("p");
  line.className = className;
  line.textContent = text;
  dom.append(line);
}
