// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/client/api";
import { CitationLibraryDialog } from "../src/client/CitationLibraryDialog";
import type { CitationLibraryEntry } from "../src/client/types";
import i18n from "../src/client/i18n";

vi.mock("../src/client/api", async (original) => ({ ...await original<typeof import("../src/client/api")>(), api: vi.fn() }));
let host: HTMLDivElement, root: Root, stored: CitationLibraryEntry, currentSource: string, currentFile: string;
const onInsert = vi.fn(), onOpenChange = vi.fn();
const click = (element: HTMLElement) => act(async () => element.click());
const tick = (ms = 0) => act(async () => { vi.advanceTimersByTime(ms); });
const rows = () => [...document.querySelectorAll<HTMLElement>(".citation-entry-card")];
const saveButton = () => document.querySelector<HTMLButtonElement>(".citation-entry-actions .save-button")!;
const posts = () => vi.mocked(api).mock.calls.filter(([url, options]) => url === "/api/citations" && options?.method === "POST");
const currentTab = () => [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((node) => node.textContent?.startsWith("Current file"))!;
async function render(readOnly = false, open = true) {
  await act(async () => root.render(createElement(CitationLibraryDialog, { open, currentFile, currentSource, readOnly,
    currentUserId: "alice", maxBibtexBytes: 100_000, onInsert, onOpenChange })));
  await tick();
}
/** Close and open the dialog again, which is when it re-reads the current file. */
async function reopen() { await render(false, false); await render(); }
const libraryTab = () => [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((node) => node.textContent?.startsWith("My library"))!;
async function openCurrent() { await click(currentTab()); await tick(180); }
async function openLibrary() { await click(libraryTab()); await tick(); }
async function chooseFolder(id = "b") {
  await act(async () => {
    const select = document.querySelector<HTMLSelectElement>(".citation-project-destination select")!;
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(select, id);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); await i18n.changeLanguage("en");
  onInsert.mockReset().mockResolvedValue(true); onOpenChange.mockReset(); currentFile = "refs.bib";
  stored = { notes: "", id: "ref", ownerId: "alice", ownerUsername: "alice", ownerDisplayName: "Alice", citationKey: "paper", entryType: "article", title: "Original", authors: null, year: null, venue: null,
    bibtex: "@article{paper,\n title={Original}\n}", revision: 1, collectionIds: ["a"], tags: [{ id: "tag", name: "Hidden tag", color: "blue", ownerId: "alice" }], createdAt: "2026-11-02", updatedAt: "2026-11-02" };
  currentSource = "@article{newKey, title={New paper}}";
  vi.mocked(api).mockReset().mockImplementation(async (url, options) => {
    if (url === "/api/citations/collections") return { collections: [{ id: "a", name: "Paper A", entryCount: 1 }, { id: "b", name: "Paper B", entryCount: 0 }], total: 1, unfiled: 0 } as never;
    if (url.startsWith("/api/citations?")) return { entries: [stored], pagination: { page: 1, pageSize: 60, total: 1, totalPages: 1 } } as never;
    if (url === "/api/citations/tags") return { tags: stored.tags } as never;
    if (url === "/api/citations/lookup") {
      const keys = JSON.parse(String(options?.body)).keys as string[];
      return { matches: keys.filter((key) => key.toLowerCase() === stored.citationKey.toLowerCase()).map(() => ({ id: stored.id, citationKey: stored.citationKey, revision: stored.revision })) } as never;
    }
    if (url === "/api/citations" && options?.method === "POST") {
      const body = JSON.parse(String(options.body));
      stored = { ...stored, ...body, collectionIds: body.collectionIds ?? stored.collectionIds, revision: stored.revision + 1 };
      return { entry: stored } as never;
    }
    throw new Error(`Unexpected project request: ${url}`);
  });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("minimal project bibliography workflow", () => {
  it("closes the project library through the shared modal close control", async () => {
    await render();
    const close = document.querySelector<HTMLButtonElement>(`.citation-project-modal .dialog-close[aria-label="${i18n.t("common.close")}"]`)!;
    await click(close);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("opens a .bib file on its own entries and any other file on the library", async () => {
    await render();
    expect([...document.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent?.replace(/\d+$/, ""))).toEqual(["Current file", "My library"]);
    expect(currentTab().getAttribute("aria-selected")).toBe("true");
    expect(vi.mocked(api).mock.calls.some(([url]) => url.startsWith("/api/citations?"))).toBe(false);
    const intro = () => document.querySelector(".citation-project-intro")?.textContent;
    expect(intro()).toBe("Save entries from this file that are not in your private library yet into the folder you choose.");
    await openLibrary();
    expect(intro()).toBe("Import entries from your private library into this BibTeX file.");
    await act(async () => root.unmount()); root = createRoot(host);
    currentFile = "main.tex"; await render();
    expect(libraryTab().getAttribute("aria-selected")).toBe("true");
    expect(intro()).toBe("Open a .bib file to import entries from your library.");
  });

  it("pages, searches and filters a large current file by library status", async () => {
    const generated = Array.from({ length: 64 }, (_, index) => `@article{gen${index}, title={Generated ${index}}}`);
    currentSource = [stored.bibtex.replace("Original", "Revised"), `@article{godel, author={G{\\"o}del, Kurt}, title={Incompleteness}}`, ...generated].join("\n");
    await render(); await tick(180);
    const keys = () => rows().map((row) => row.querySelector("code")?.textContent);
    const pager = () => document.querySelector(".citation-library-pagination");
    const filter = (label: string) => [...document.querySelectorAll<HTMLButtonElement>(".citation-status-filters button")].find((button) => button.textContent?.startsWith(label))!;
    const search = async (value: string) => act(async () => {
      const input = document.querySelector<HTMLInputElement>(".citation-library-search input")!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });

    expect(rows()).toHaveLength(60);
    expect(pager()?.textContent).toContain("Page 1 of 2 · 66 entries");
    expect([...document.querySelectorAll(".citation-status-filters button")].map((button) => button.textContent))
      .toEqual(["All66", "Not in library65"]);
    await click([...pager()!.querySelectorAll("button")].at(-1)!);
    expect(keys()).toEqual(["gen58", "gen59", "gen60", "gen61", "gen62", "gen63"]);

    // Changing a filter returns to the first page; accents and case do not matter in search.
    await click(filter("Not in library"));
    expect(keys()[0]).toBe("godel"); expect(keys()).not.toContain("paper");
    expect(pager()?.textContent).toContain("Page 1 of 2 · 65 entries");
    await click(filter("All")); await search("GODEL kurt");
    expect(keys()).toEqual(["godel"]);
    await search("no such entry");
    expect(rows()).toHaveLength(0);
    expect(document.querySelector(".citation-library-empty")?.textContent).toBe("No entries in this file match.");
  });

  it("keeps the status filter unavailable until the comparison is ready and re-reads the file only when reopened", async () => {
    currentSource = Array.from({ length: 61 }, (_, index) => `@article{gen${index}, title={G}}`).join("\n");
    await render();
    expect([...document.querySelectorAll<HTMLButtonElement>(".citation-status-filters button")].map((button) => button.disabled)).toEqual([false, true]);
    await tick(180);
    await click([...document.querySelectorAll<HTMLButtonElement>(".citation-library-pagination button")].at(-1)!);
    expect(rows().map((row) => row.querySelector("code")?.textContent)).toEqual(["gen60"]);
    // The open dialog keeps the file as it was read; reopening shows the edit.
    const lookups = () => vi.mocked(api).mock.calls.filter(([url]) => url === "/api/citations/lookup").length;
    const before = lookups();
    currentSource = "@article{only, title={Only}}"; await render(); await tick(180);
    expect(rows().map((row) => row.querySelector("code")?.textContent)).toEqual(["gen60"]);
    expect(lookups()).toBe(before);
    await reopen(); await tick(180);
    expect(rows().map((row) => row.querySelector("code")?.textContent)).toEqual(["only"]);
    expect(document.querySelector(".citation-library-pagination")).toBeNull();
  });

  it("shows the folder sidebar only for the library and keeps the save destination separate from its filter", async () => {
    await render();
    expect(document.querySelector(".citation-collection-select")).toBeNull();
    expect(document.querySelector(".citation-library-layout")?.classList.contains("without-sidebar")).toBe(true);
    await chooseFolder("b"); await openLibrary();
    expect(document.querySelector(".citation-library-scope-heading")?.textContent).toBe("All references");
    await click([...document.querySelectorAll<HTMLButtonElement>(".citation-collection-select")].find((button) => button.querySelector("span")?.textContent === "Paper A")!); await tick();
    await openCurrent();
    // A destination the user already chose is not replaced by the folder being browsed.
    expect(document.querySelector<HTMLSelectElement>(".citation-project-destination select")?.value).toBe("b");
  });

  it("renders icon-only Import with a tooltip and tag filters without management tools", async () => {
    await render(); await openLibrary();
    expect(rows()).toHaveLength(1);
    expect([...rows()[0].querySelectorAll("button")].map((button) => button.textContent)).toEqual(["Import"]);
    expect(document.querySelector(".citation-tag-manage, .citation-entry-controls, .citation-add-entry-button, .citation-collection-menu-trigger")).toBeNull();
    expect(rows()[0].textContent).not.toContain("Hidden tag");
    expect(document.querySelector(".citation-tag-filters")?.textContent).toContain("Hidden tag");
    const importButton = rows()[0].querySelector<HTMLButtonElement>("button")!;
    expect(importButton.getAttribute("aria-label")).toBe("Import");
    expect(importButton.getAttribute("data-tooltip")).toBe("Import into the current BibTeX file");
    expect(importButton.querySelector("span")?.classList.contains("sr-only")).toBe(true);
    expect(importButton.hasAttribute("title")).toBe(false);
    await click(rows()[0].querySelector<HTMLButtonElement>("button")!);
    expect(onInsert).toHaveBeenCalledExactlyOnceWith(stored); expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("combines tag, folder and search filters and resets pagination without exposing tag management", async () => {
    const implementation = vi.mocked(api).getMockImplementation()!;
    vi.mocked(api).mockImplementation((url, options) => {
      if (url.startsWith("/api/citations?")) {
        const params = new URLSearchParams(url.split("?")[1]);
        return Promise.resolve({ entries: [stored], pagination: { page: Number(params.get("page")), pageSize: 60, total: 61, totalPages: 2 } } as never);
      }
      return implementation(url, options);
    });
    await render(); await openLibrary();
    await click([...document.querySelectorAll<HTMLButtonElement>(".citation-library-pagination button")].at(-1)!); await tick();
    expect(vi.mocked(api).mock.calls.some(([url]) => url.includes("page=2"))).toBe(true);
    await click([...document.querySelectorAll<HTMLButtonElement>(".citation-collection-select")].find((button) => button.querySelector("span")?.textContent === "Paper A")!); await tick();
    await click([...document.querySelectorAll<HTMLButtonElement>(".citation-tag-filters button")].find((button) => button.textContent === "Hidden tag")!); await tick();
    await act(async () => {
      const input = document.querySelector<HTMLInputElement>(".citation-library-search input")!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "retrieval");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await tick(180);
    const last = vi.mocked(api).mock.calls.filter(([url]) => url.startsWith("/api/citations?")).at(-1)![0];
    expect(Object.fromEntries(new URLSearchParams(last.split("?")[1]))).toMatchObject({ collection: "a", tag: "tag", q: "retrieval", page: "1" });
    expect(document.querySelector(".citation-tag-manage")).toBeNull();
  });

  it("requires a destination for new references, blocks duplicate submission and saves without opening tag editors", async () => {
    await render(); await openCurrent();
    expect(saveButton().disabled).toBe(true); expect(saveButton().getAttribute("data-tooltip")).toContain("Choose a folder");
    await click(saveButton()); expect(posts()).toHaveLength(0);
    await chooseFolder(); expect(saveButton().disabled).toBe(false);
    expect(saveButton().getAttribute("aria-label")).toBe("Save");
    expect(saveButton().querySelector(".lucide-save")).not.toBeNull();
    expect(saveButton().querySelector("span")?.classList.contains("sr-only")).toBe(true);
    const implementation = vi.mocked(api).getMockImplementation()!;
    let finish!: () => void;
    vi.mocked(api).mockImplementation((url, options) => url === "/api/citations" ? new Promise((resolve) => { finish = () => resolve(implementation(url, options)); }) : implementation(url, options));
    await click(saveButton()); await click(saveButton());
    expect(posts()).toHaveLength(1);
    const body = JSON.parse(String(posts()[0][1]?.body));
    expect(body).toMatchObject({ citationKey: "newKey", collectionIds: ["b"] });
    expect(body.overwrite).toBeUndefined(); expect(body.expectedRevision).toBeUndefined(); expect(body.tagIds).toBeUndefined();
    await act(async () => finish()); await tick(180);
    // Once saved, the entry is in the library: it shows "Saved" and offers no action.
    expect(rows()[0].querySelectorAll("button")).toHaveLength(0);
    expect(rows()[0].querySelector(".citation-entry-heading em")?.textContent).toBe("Saved");
    expect(document.querySelector(".citation-tag-editor, .citation-entry-controls")).toBeNull();
  });

  it("never offers to change an entry that is already in the library, even when the file's copy differs", async () => {
    currentSource = `${stored.bibtex.replace("Original", "Revised")}\n@article{newKey, title={New paper}}`;
    await render(); await tick(180); await chooseFolder();
    const [inLibrary, fresh] = rows();
    expect(inLibrary.querySelector("code")?.textContent).toBe("paper");
    expect(inLibrary.querySelectorAll("button")).toHaveLength(0);
    expect(inLibrary.querySelector(".citation-entry-heading em")?.textContent).toBe("Saved");
    expect([...fresh.querySelectorAll("button")].map((button) => button.getAttribute("aria-label"))).toEqual(["Save"]);
    expect(document.body.textContent).not.toMatch(/Update|up to date/i);
    expect(posts()).toHaveLength(0);
  });

  it("keeps saving disabled after a failed library check and retries when the current-file tab is reopened", async () => {
    await render(false, false);
    const implementation = vi.mocked(api).getMockImplementation()!;
    let failed = false;
    vi.mocked(api).mockImplementation(async (url, options) => {
      if (url === "/api/citations/lookup" && !failed) { failed = true; throw new Error("Comparison unavailable"); }
      return implementation(url, options);
    });
    await render(); await chooseFolder(); await tick(180);
    expect(saveButton().disabled).toBe(true); expect(document.querySelector('[role="alert"]')?.textContent).toBe("Comparison unavailable");
    await click(saveButton()); expect(posts()).toHaveLength(0);
    await openLibrary(); await openCurrent();
    expect(saveButton().disabled).toBe(false); expect(document.querySelector('[role="alert"]')).toBeNull();
  });

  it("aborts and ignores library checks for old file contents when reopened", async () => {
    await render(false, false);
    let finish!: (value: never) => void, oldSignal: AbortSignal | null | undefined;
    const implementation = vi.mocked(api).getMockImplementation()!;
    vi.mocked(api).mockImplementation((url, options) => {
      if (url !== "/api/citations/lookup" || oldSignal) return implementation(url, options);
      oldSignal = options?.signal;
      return new Promise((resolve) => { finish = resolve; });
    });
    await render(); await chooseFolder(); await tick(180);
    currentSource = "@article{newKey, title={Edited}}"; await render();
    expect(oldSignal?.aborted).toBe(false);
    await reopen(); await chooseFolder(); await tick(180);
    expect(oldSignal?.aborted).toBe(true); expect(saveButton().disabled).toBe(false);
    // A late answer for the old reading must not mark the entry as saved.
    await act(async () => finish({ matches: [{ id: "x", citationKey: "newKey", revision: 1 }] } as never));
    expect(saveButton().disabled).toBe(false);
  });

  it("does not apply a pending save's feedback or cache to a different file", async () => {
    await render(); await openCurrent(); await chooseFolder();
    let finish!: (value: never) => void, oldSignal: AbortSignal | null | undefined;
    vi.mocked(api).mockImplementationOnce((_url, options) => { oldSignal = options?.signal; return new Promise((resolve) => { finish = resolve; }); });
    await click(saveButton());
    currentFile = "other.bib"; currentSource = "@article{other, title={Other}}"; await render(); await openCurrent();
    expect(oldSignal?.aborted).toBe(true);
    await act(async () => finish({ entry: { ...stored, citationKey: "newKey" } } as never));
    expect(saveButton().textContent).toBe("Save"); expect(document.body.textContent).not.toContain("New paper");
  });

  it("blocks project imports for readers but allows saving into their own private library", async () => {
    await render(true); expect(rows()[0].querySelector<HTMLButtonElement>("button")?.disabled).toBe(true);
    await openCurrent(); await chooseFolder(); expect(saveButton().disabled).toBe(false);
    await click(saveButton()); expect(posts()).toHaveLength(1); expect(onInsert).not.toHaveBeenCalled();
  });
});
