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

function abortError(): DOMException {
  return new DOMException("The operation was aborted", "AbortError");
}

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
  options: Pick<CitationHoverOptions, "projectId" | "filePath" | "mainFile">
): CitationResolver {
  const fileCache = new Map<string, { revision: string; entries: Map<string, BibtexEntrySummary> }>();
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

  const loadEntries = async (target: ResolvedCitationTarget, signal: AbortSignal): Promise<Map<string, BibtexEntrySummary>> => {
    const cached = fileCache.get(target.path);
    if (cached && target.revision && cached.revision === target.revision) {
      // Refresh recency so the file being used is evicted last.
      fileCache.delete(target.path);
      fileCache.set(target.path, cached);
      return cached.entries;
    }
    fileCache.delete(target.path);
    const result = await api<{ path: string; content: string }>(
      `${project}/file?path=${encodeURIComponent(target.path)}`, { signal }
    );
    if (signal.aborted) throw abortError();
    const summaries = await parseBibtexMetadataInWorker(result.content);
    if (signal.aborted) throw abortError();
    const entries = new Map(summaries.map((entry) => [entry.key, entry]));
    // The content was read after the revision was reported, so it is at least
    // as new as that revision: a later change makes the next lookup disagree
    // and refetch, while the entries are never older than the revision claims.
    if (target.revision) {
      fileCache.set(target.path, { revision: target.revision, entries });
      while (fileCache.size > MAX_FILE_CACHE_ENTRIES) {
        const oldest = fileCache.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        fileCache.delete(oldest);
      }
    }
    return entries;
  };

  return async (reference, signal) => {
    const target = await lookup(reference, signal);
    if (!target) return null;
    if (target.source !== "bibtex" || !/\.bib$/i.test(target.path)) return { ...target, citation: null };
    const entries = await loadEntries(target, signal);
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
