// @vitest-environment happy-dom
import type { EditorView } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BibtexEntrySummary } from "../src/client/bibtex/entryMetadata";
import { api } from "../src/client/api";
import { parseBibtexMetadataInWorker } from "../src/client/bibtexMetadata";
import {
  citationTooltip, createCitationFileCache, createCitationResolver, renderCitationHover,
  type CitationFileCache, type CitationHoverLabels, type CitationHoverTarget
} from "../src/client/citationHover";
import type { LatexReference } from "../src/shared/latexReferences";

vi.mock("../src/client/api", () => ({ api: vi.fn() }));
vi.mock("../src/client/bibtexMetadata", () => ({ parseBibtexMetadataInWorker: vi.fn() }));

const labels: CitationHoverLabels = {
  loading: "Loading bibliography entry…",
  unavailable: "Bibliography details are unavailable.",
  inSource: "In-source bibliography entry",
  untitled: "Untitled citation",
  doi: "DOI",
  url: "URL",
  openHint: "Ctrl/Cmd-click to open this entry.",
  entry: (key) => `Bibliography entry ${key}`,
  notFound: (key) => `No bibliography entry was found for ${key}.`,
  authorsTruncated: (names, count) => `${names} et al. (${count} authors)`,
  authorsOthers: (names) => `${names} et al.`
};

function render(target: CitationHoverTarget | null | undefined, key = "smith2025") {
  const dom = document.createElement("div");
  renderCitationHover(dom, key, target, labels);
  return dom;
}

describe("citation hover rendering", () => {
  it("shows structured BibTeX metadata and its source location", () => {
    const dom = render({
      path: "refs.bib", line: 12, column: 1, source: "bibtex",
      citation: {
        key: "smith2025", entryType: "article", title: "A {Nested} title",
        authors: "Smith, Ada", year: "2025", venue: "Journal of Testing",
        doi: "10.1000/example", url: "https://example.test/paper"
      }
    });
    expect(dom.querySelector(".texlite-citation-heading code")?.textContent).toBe("smith2025");
    expect(dom.querySelector(".texlite-citation-heading span")?.textContent).toBe("@article");
    expect(dom.querySelector(".texlite-citation-title")?.textContent).toBe("A {Nested} title");
    expect(dom.querySelector(".texlite-citation-authors")?.textContent).toBe("Smith, Ada");
    expect(dom.querySelector(".texlite-citation-meta")?.textContent).toBe("Journal of Testing · 2025");
    expect([...dom.querySelectorAll(".texlite-citation-meta")].map((node) => node.textContent))
      .toContain("DOI: 10.1000/example");
    expect(dom.querySelector(".texlite-citation-url")?.textContent).toBe("URL: https://example.test/paper");
    expect(dom.querySelector(".texlite-citation-hint")?.textContent).toBe("Ctrl/Cmd-click to open this entry.");
    expect(dom.querySelector(".texlite-citation-source")?.textContent).toBe("refs.bib:12");
  });

  it("distinguishes missing, unavailable and in-source entries", () => {
    expect(render(null, "missing").querySelector(".texlite-citation-message.error")?.textContent)
      .toBe("No bibliography entry was found for missing.");
    expect(render(undefined).querySelector(".texlite-citation-message.error")?.textContent)
      .toBe("Bibliography details are unavailable.");
    expect(render({ path: "main.tex", line: 4, column: 1, source: "bibitem", citation: null })
      .querySelector(".texlite-citation-message.muted")?.textContent)
      .toBe("In-source bibliography entry");
    expect(render({ path: "refs.bib", line: 1, column: 1, source: "bibtex", citation: null })
      .querySelector(".texlite-citation-message.muted")?.textContent)
      .toBe("Bibliography details are unavailable.");
  });
});

const summary = (key: string, title: string): BibtexEntrySummary => ({
  key, entryType: "article", title, authors: null, year: null, venue: null, doi: null, url: null
});
const reference = (key: string): LatexReference => ({ kind: "citation", command: "cite", key, from: 0, to: key.length });
const bibTarget = (revision: string | undefined, path = "refs.bib") => ({
  path, line: 3, column: 1, kind: "citation", source: "bibtex", ...(revision === undefined ? {} : { revision })
});

describe("citation hover authors", () => {
  it("shortens a long author list with biblatex's default rule", () => {
    const dom = render({
      path: "refs.bib", line: 3, column: 1, source: "bibtex",
      citation: { ...summary("smith2025", "Title"), authors: "A and B and C and D" }
    });
    const authors = dom.querySelector(".texlite-citation-authors") as HTMLElement;
    expect(authors.textContent).toBe("A et al. (4 authors)");
    expect(authors.dataset.tooltip).toBeUndefined();
  });
});

describe("citation hover resolution", () => {
  const options = { projectId: "paper one", filePath: "chapters/intro.tex", mainFile: "main.tex" };
  let target: ReturnType<typeof bibTarget> | null;
  let content: string;
  let files: CitationFileCache;

  beforeEach(() => {
    files = createCitationFileCache();
    vi.mocked(api).mockReset();
    vi.mocked(parseBibtexMetadataInWorker).mockReset();
    target = bibTarget("1:100");
    content = "@article{a, title={One}}";
    vi.mocked(api).mockImplementation(async (url: string) => (url.includes("/references/resolve")
      ? { target } : { path: "refs.bib", content }) as never);
    vi.mocked(parseBibtexMetadataInWorker).mockImplementation(async (source: string) =>
      [summary("a", source.includes("Two") ? "Two" : "One"), summary("b", "Other")]);
  });

  const requests = (fragment: string) => vi.mocked(api).mock.calls.filter(([url]) => url.includes(fragment));

  it("asks for the main-document-aware target below the project's encoded path", async () => {
    const result = await createCitationResolver(options, files)(reference("a"), new AbortController().signal);
    expect(result).toMatchObject({ path: "refs.bib", line: 3, citation: { key: "a", title: "One" } });
    const [url] = requests("/references/resolve")[0];
    const query = new URL(url, "http://texlite.test").searchParams;
    expect(url.startsWith("/api/projects/paper%20one/references/resolve?")).toBe(true);
    expect(Object.fromEntries(query)).toEqual({
      kind: "citation", key: "a", path: "chapters/intro.tex", mainFile: "main.tex"
    });
    expect(requests("/file?path=refs.bib")).toHaveLength(1);
  });

  it("never remembers a missing key, so a newly added entry is found immediately", async () => {
    const resolve = createCitationResolver(options, files);
    target = null;
    await expect(resolve(reference("a"), new AbortController().signal)).resolves.toBeNull();
    target = bibTarget("2:200");
    await expect(resolve(reference("a"), new AbortController().signal))
      .resolves.toMatchObject({ citation: { key: "a" } });
    expect(requests("/references/resolve")).toHaveLength(2);
  });

  it("reuses one parsed file across keys while the server revision is unchanged", async () => {
    const resolve = createCitationResolver(options, files);
    const { signal } = new AbortController();
    await resolve(reference("a"), signal);
    await expect(resolve(reference("b"), signal)).resolves.toMatchObject({ citation: { key: "b", title: "Other" } });
    expect(requests("/file?path=")).toHaveLength(1);
    expect(parseBibtexMetadataInWorker).toHaveBeenCalledTimes(1);
  });

  it("refetches the file as soon as its revision changes", async () => {
    const resolve = createCitationResolver(options, files);
    const { signal } = new AbortController();
    await expect(resolve(reference("a"), signal)).resolves.toMatchObject({ citation: { title: "One" } });
    content = "@article{a, title={Two}}";
    target = bibTarget("1:250");
    await expect(resolve(reference("a"), signal)).resolves.toMatchObject({ citation: { title: "Two" } });
    expect(requests("/file?path=")).toHaveLength(2);
  });

  it("does not reuse a file when the server gives no revision", async () => {
    const resolve = createCitationResolver(options, files);
    const { signal } = new AbortController();
    target = bibTarget(undefined);
    await resolve(reference("a"), signal);
    await resolve(reference("a"), signal);
    expect(requests("/file?path=")).toHaveLength(2);
  });

  it("does not fetch a file for an in-source bibliography entry", async () => {
    target = { path: "main.tex", line: 4, column: 1, kind: "citation", source: "bibitem", revision: "1:1" };
    await expect(createCitationResolver(options, files)(reference("a"), new AbortController().signal))
      .resolves.toMatchObject({ source: "bibitem", citation: null });
    expect(requests("/file?path=")).toHaveLength(0);
  });

  it("rejects an aborted hover but keeps its finished parse for the next one", async () => {
    const resolve = createCitationResolver(options, files);
    const controller = new AbortController();
    let release!: (entries: BibtexEntrySummary[]) => void;
    vi.mocked(parseBibtexMetadataInWorker).mockImplementationOnce(() => new Promise((done) => { release = done; }));
    const pending = resolve(reference("a"), controller.signal);
    await vi.waitFor(() => expect(parseBibtexMetadataInWorker).toHaveBeenCalledTimes(1));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    release([summary("a", "Finished")]);

    await expect(resolve(reference("a"), new AbortController().signal))
      .resolves.toMatchObject({ citation: { title: "Finished" } });
    expect(requests("/file?path=")).toHaveLength(1);
    expect(parseBibtexMetadataInWorker).toHaveBeenCalledTimes(1);
  });

  it("shares one load between hovers that move to another key before it finishes", async () => {
    const resolve = createCitationResolver(options, files);
    let release!: (entries: BibtexEntrySummary[]) => void;
    vi.mocked(parseBibtexMetadataInWorker).mockImplementationOnce(() => new Promise((done) => { release = done; }));
    const first = new AbortController();
    const abandoned = resolve(reference("a"), first.signal);
    await vi.waitFor(() => expect(parseBibtexMetadataInWorker).toHaveBeenCalledTimes(1));
    first.abort();
    const next = resolve(reference("b"), new AbortController().signal);
    await vi.waitFor(() => expect(requests("/references/resolve")).toHaveLength(2));
    release([summary("a", "One"), summary("b", "Other")]);

    await expect(abandoned).rejects.toMatchObject({ name: "AbortError" });
    await expect(next).resolves.toMatchObject({ citation: { key: "b", title: "Other" } });
    expect(requests("/file?path=")).toHaveLength(1);
  });

  it("does not let an older revision that finishes late replace a newer one", async () => {
    const resolve = createCitationResolver(options, files);
    let releaseOld!: (entries: BibtexEntrySummary[]) => void;
    vi.mocked(parseBibtexMetadataInWorker).mockImplementationOnce(() => new Promise((done) => { releaseOld = done; }));
    const old = resolve(reference("a"), new AbortController().signal);
    await vi.waitFor(() => expect(parseBibtexMetadataInWorker).toHaveBeenCalledTimes(1));
    content = "@article{a, title={Two}}";
    target = bibTarget("1:250");
    await expect(resolve(reference("a"), new AbortController().signal))
      .resolves.toMatchObject({ citation: { title: "Two" } });
    releaseOld([summary("a", "One")]);
    await expect(old).resolves.toMatchObject({ citation: { title: "One" } });

    await expect(resolve(reference("a"), new AbortController().signal))
      .resolves.toMatchObject({ citation: { title: "Two" } });
    expect(requests("/file?path=")).toHaveLength(2);
  });

  it("retries a failed load instead of remembering the failure", async () => {
    const resolve = createCitationResolver(options, files);
    vi.mocked(parseBibtexMetadataInWorker).mockRejectedValueOnce(new Error("worker failed"));
    await expect(resolve(reference("a"), new AbortController().signal)).rejects.toThrow("worker failed");
    await expect(resolve(reference("a"), new AbortController().signal))
      .resolves.toMatchObject({ citation: { title: "One" } });
    expect(requests("/file?path=")).toHaveLength(2);
  });

  it("keeps parsed files across resolvers, such as an editor remounted for another file", async () => {
    await createCitationResolver(options, files)(reference("a"), new AbortController().signal);
    await expect(createCitationResolver({ ...options, filePath: "chapters/two.tex" }, files)(reference("b"), new AbortController().signal))
      .resolves.toMatchObject({ citation: { key: "b" } });
    expect(requests("/file?path=")).toHaveLength(1);

    await createCitationResolver({ ...options, projectId: "paper two" }, files)(reference("a"), new AbortController().signal);
    expect(requests("/file?path=")).toHaveLength(2);
    expect(requests("/api/projects/paper%20two/file?path=")).toHaveLength(1);
  });

  it("keeps the most recently used files when the cache is full", async () => {
    const resolve = createCitationResolver(options, files);
    const { signal } = new AbortController();
    const visit = async (path: string) => {
      target = bibTarget("1:1", path);
      await resolve(reference("a"), signal);
    };
    for (let index = 0; index < 9; index += 1) await visit(`bib${index}.bib`);
    expect(requests("/file?path=")).toHaveLength(9);
    await visit("bib8.bib");
    expect(requests("/file?path=")).toHaveLength(9);
    await visit("bib0.bib");
    expect(requests("/file?path=")).toHaveLength(10);
  });
});

describe("citation hover background downloads", () => {
  const options = { projectId: "paper", filePath: "main.tex", mainFile: "main.tex" };
  const target = bibTarget("1:100");
  let downloads: { signal: AbortSignal; finish: (content: string) => void }[];
  let files: CitationFileCache;

  beforeEach(() => {
    vi.useFakeTimers();
    downloads = [];
    files = createCitationFileCache({ downloadTimeoutMs: 1_000, idleDownloadAbortMs: 100 });
    vi.mocked(api).mockReset();
    vi.mocked(parseBibtexMetadataInWorker).mockReset();
    vi.mocked(parseBibtexMetadataInWorker).mockImplementation(async () => [summary("a", "One"), summary("b", "Other")]);
    vi.mocked(api).mockImplementation(async (url: string, init?: { signal?: AbortSignal | null }) => {
      if (url.includes("/references/resolve")) return { target } as never;
      const signal = init!.signal!;
      return await new Promise<{ path: string; content: string }>((resolve, reject) => {
        downloads.push({ signal, finish: (content) => resolve({ path: "refs.bib", content }) });
        signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      }) as never;
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const hover = (key: string) => {
    const controller = new AbortController();
    const result = createCitationResolver(options, files)(reference(key), controller.signal);
    result.catch(() => undefined);
    return { result, close: () => controller.abort() };
  };

  it("abandons a download that does not finish before its deadline", async () => {
    const first = hover("a");
    await vi.advanceTimersByTimeAsync(999);
    expect(downloads[0].signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(downloads[0].signal.aborted).toBe(true);
    await expect(first.result).rejects.toBeDefined();

    // The failure is not remembered: the next hover starts a fresh download.
    const next = hover("a");
    await vi.advanceTimersByTimeAsync(0);
    expect(downloads).toHaveLength(2);
    downloads[1].finish("@article{a, title={One}}");
    await expect(next.result).resolves.toMatchObject({ citation: { title: "One" } });
  });

  it("aborts a download once no hover has waited for it during the grace period", async () => {
    const first = hover("a");
    await vi.advanceTimersByTimeAsync(0);
    first.close();
    await vi.advanceTimersByTimeAsync(99);
    expect(downloads[0].signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(downloads[0].signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps a download for a hover that joins within the grace period", async () => {
    const first = hover("a");
    await vi.advanceTimersByTimeAsync(0);
    first.close();
    await vi.advanceTimersByTimeAsync(50);
    const next = hover("b");
    await vi.advanceTimersByTimeAsync(500);
    expect(downloads).toHaveLength(1);
    expect(downloads[0].signal.aborted).toBe(false);
    downloads[0].finish("@article{a, title={One}}");
    await expect(next.result).resolves.toMatchObject({ citation: { key: "b" } });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not abort a finished download whose parse outlives every hover", async () => {
    let release!: (entries: BibtexEntrySummary[]) => void;
    vi.mocked(parseBibtexMetadataInWorker).mockImplementationOnce(() => new Promise((done) => { release = done; }));
    const first = hover("a");
    await vi.advanceTimersByTimeAsync(0);
    downloads[0].finish("@article{a, title={One}}");
    await vi.advanceTimersByTimeAsync(0);
    first.close();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(downloads[0].signal.aborted).toBe(false);
    release([summary("a", "Parsed later")]);
    await vi.advanceTimersByTimeAsync(0);

    await expect(hover("a").result).resolves.toMatchObject({ citation: { title: "Parsed later" } });
    expect(downloads).toHaveLength(1);
  });
});

describe("citation hover tooltip lifecycle", () => {
  const create = (resolve: Parameters<typeof citationTooltip>[1]) => {
    const view = citationTooltip(reference("smith2025"), resolve, labels).create({} as EditorView);
    return { view, text: () => view.dom.textContent ?? "" };
  };

  it("shows a loading state, then renders the resolved entry", async () => {
    let finish!: (target: CitationHoverTarget | null) => void;
    const { view, text } = create(() => new Promise((done) => { finish = done; }));
    expect(text()).toBe(labels.loading);
    finish({ path: "refs.bib", line: 2, column: 1, source: "bibtex", citation: { ...summary("smith2025", "A title") } });
    await vi.waitFor(() => expect(view.dom.querySelector(".texlite-citation-title")?.textContent).toBe("A title"));
  });

  it("reports a failed lookup without caching it as a missing entry", async () => {
    const { view } = create(() => Promise.reject(new Error("offline")));
    await vi.waitFor(() => expect(view.dom.querySelector(".texlite-citation-message.error")?.textContent)
      .toBe(labels.unavailable));
  });

  it("aborts the request when closed and never renders a late result", async () => {
    let signal!: AbortSignal;
    let finish!: (target: CitationHoverTarget | null) => void;
    const { view, text } = create((_reference, requestSignal) => {
      signal = requestSignal;
      return new Promise((done) => { finish = done; });
    });
    expect(signal.aborted).toBe(false);
    view.destroy?.();
    expect(signal.aborted).toBe(true);
    finish({ path: "refs.bib", line: 2, column: 1, source: "bibtex", citation: summary("smith2025", "Late") });
    await Promise.resolve();
    expect(text()).toBe(labels.loading);
  });
});
