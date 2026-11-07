// @vitest-environment happy-dom
import type { EditorView } from "@codemirror/view";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BibtexEntrySummary } from "../src/client/bibtex/entryMetadata";
import { api } from "../src/client/api";
import { parseBibtexMetadataInWorker } from "../src/client/bibtexMetadata";
import {
  citationTooltip, createCitationResolver, renderCitationHover,
  type CitationHoverLabels, type CitationHoverTarget
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
  notFound: (key) => `No bibliography entry was found for ${key}.`
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

describe("citation hover resolution", () => {
  const options = { projectId: "paper one", filePath: "chapters/intro.tex", mainFile: "main.tex" };
  let target: ReturnType<typeof bibTarget> | null;
  let content: string;

  beforeEach(() => {
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
    const result = await createCitationResolver(options)(reference("a"), new AbortController().signal);
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
    const resolve = createCitationResolver(options);
    target = null;
    await expect(resolve(reference("a"), new AbortController().signal)).resolves.toBeNull();
    target = bibTarget("2:200");
    await expect(resolve(reference("a"), new AbortController().signal))
      .resolves.toMatchObject({ citation: { key: "a" } });
    expect(requests("/references/resolve")).toHaveLength(2);
  });

  it("reuses one parsed file across keys while the server revision is unchanged", async () => {
    const resolve = createCitationResolver(options);
    const { signal } = new AbortController();
    await resolve(reference("a"), signal);
    await expect(resolve(reference("b"), signal)).resolves.toMatchObject({ citation: { key: "b", title: "Other" } });
    expect(requests("/file?path=")).toHaveLength(1);
    expect(parseBibtexMetadataInWorker).toHaveBeenCalledTimes(1);
  });

  it("refetches the file as soon as its revision changes", async () => {
    const resolve = createCitationResolver(options);
    const { signal } = new AbortController();
    await expect(resolve(reference("a"), signal)).resolves.toMatchObject({ citation: { title: "One" } });
    content = "@article{a, title={Two}}";
    target = bibTarget("1:250");
    await expect(resolve(reference("a"), signal)).resolves.toMatchObject({ citation: { title: "Two" } });
    expect(requests("/file?path=")).toHaveLength(2);
  });

  it("does not reuse a file when the server gives no revision", async () => {
    const resolve = createCitationResolver(options);
    const { signal } = new AbortController();
    target = bibTarget(undefined);
    await resolve(reference("a"), signal);
    await resolve(reference("a"), signal);
    expect(requests("/file?path=")).toHaveLength(2);
  });

  it("does not fetch a file for an in-source bibliography entry", async () => {
    target = { path: "main.tex", line: 4, column: 1, kind: "citation", source: "bibitem", revision: "1:1" };
    await expect(createCitationResolver(options)(reference("a"), new AbortController().signal))
      .resolves.toMatchObject({ source: "bibitem", citation: null });
    expect(requests("/file?path=")).toHaveLength(0);
  });

  it("rejects when aborted mid-flight and caches nothing from the abandoned parse", async () => {
    const resolve = createCitationResolver(options);
    const controller = new AbortController();
    let release!: (entries: BibtexEntrySummary[]) => void;
    vi.mocked(parseBibtexMetadataInWorker).mockImplementationOnce(() => new Promise((done) => { release = done; }));
    const pending = resolve(reference("a"), controller.signal);
    await vi.waitFor(() => expect(parseBibtexMetadataInWorker).toHaveBeenCalledTimes(1));
    controller.abort();
    release([summary("a", "Abandoned")]);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });

    await expect(resolve(reference("a"), new AbortController().signal))
      .resolves.toMatchObject({ citation: { title: "One" } });
    expect(requests("/file?path=")).toHaveLength(2);
  });

  it("keeps the most recently used files when the cache is full", async () => {
    const resolve = createCitationResolver(options);
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
