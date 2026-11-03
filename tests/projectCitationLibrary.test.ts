// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/client/api";
import { CitationLibraryDialog } from "../src/client/CitationLibraryDialog";
import { comparableCitationBibtex } from "../src/shared/citationContent";
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
async function render(readOnly = false) {
  await act(async () => root.render(createElement(CitationLibraryDialog, { open: true, currentFile, currentSource, readOnly,
    currentUserId: "alice", maxBibtexBytes: 100_000, onInsert, onOpenChange })));
  await tick();
}
async function openCurrent() { await click(currentTab()); await tick(180); }
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
  stored = { notes: "", id: "ref", ownerId: "alice", ownerUsername: "alice", ownerDisplayName: "Alice", citationKey: "paper", entryType: "article", title: "Original", authors: null, year: null,
    bibtex: "@article{paper,\n title={Original}\n}", revision: 1, collectionIds: ["a"], tags: [{ id: "tag", name: "Hidden tag", color: "blue", ownerId: "alice" }], createdAt: "2026-11-02", updatedAt: "2026-11-02" };
  currentSource = "@article{newKey, title={New paper}}";
  vi.mocked(api).mockReset().mockImplementation(async (url, options) => {
    if (url === "/api/citations/collections") return { collections: [{ id: "a", name: "Paper A", entryCount: 1 }, { id: "b", name: "Paper B", entryCount: 0 }], total: 1, unfiled: 0 } as never;
    if (url.startsWith("/api/citations?")) return { entries: [stored], pagination: { page: 1, pageSize: 60, total: 1, totalPages: 1 } } as never;
    if (url === "/api/citations/tags") return { tags: stored.tags } as never;
    if (url === "/api/citations/lookup") {
      const entries = JSON.parse(String(options?.body)).entries as Array<{ citationKey: string; bibtex: string }>;
      return { matches: entries.filter((entry) => entry.citationKey.toLowerCase() === stored.citationKey.toLowerCase()).map((entry) => ({ id: stored.id, citationKey: stored.citationKey, revision: stored.revision,
        sameContent: comparableCitationBibtex(entry.bibtex) === comparableCitationBibtex(stored.bibtex) })) } as never;
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

  it("renders icon-only Import with a tooltip and tag filters without management tools", async () => {
    await render();
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
    await render();
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
    expect(JSON.parse(String(posts()[0][1]?.body))).toMatchObject({ citationKey: "newKey", collectionIds: ["b"], overwrite: false });
    expect(JSON.parse(String(posts()[0][1]?.body)).tagIds).toBeUndefined();
    await act(async () => finish()); await tick(180);
    expect(saveButton().textContent).toBe("Saved"); expect(saveButton().disabled).toBe(true);
    expect(saveButton().getAttribute("data-tooltip")).toBe("Saved");
    expect(saveButton().querySelector(".save-button-confirmation")).not.toBeNull();
    expect(document.querySelector(".citation-tag-editor, .citation-entry-controls")).toBeNull();
    expect([...rows()[0].querySelectorAll("button")]).toHaveLength(1);
  });

  it("only enables Update when content changes and preserves existing folders without requiring a new destination", async () => {
    currentSource = `\r\n${stored.bibtex.replaceAll("\n", "\r\n")}\r\n`;
    await render(); await openCurrent();
    expect(saveButton().textContent).toBe("Update"); expect(saveButton().disabled).toBe(true);
    expect(saveButton().getAttribute("aria-label")).toBe("Update");
    expect(saveButton().querySelector(".lucide-refresh-cw")).not.toBeNull();
    expect(saveButton().getAttribute("data-tooltip")).toContain("Already up to date");
    currentSource = stored.bibtex.replace("Original", "Revised"); await render();
    expect(saveButton().disabled).toBe(true); await tick(180);
    expect(saveButton().textContent).toBe("Update"); expect(saveButton().disabled).toBe(false);
    expect(document.querySelector<HTMLSelectElement>(".citation-project-destination select")?.value).toBe("");
    await click(saveButton()); await tick(180);
    expect(JSON.parse(String(posts()[0][1]?.body))).toMatchObject({ overwrite: true, expectedRevision: 1 });
    expect(JSON.parse(String(posts()[0][1]?.body)).collectionIds).toBeUndefined();
    expect(stored.collectionIds).toEqual(["a"]); expect(saveButton().disabled).toBe(true);
    await tick(2000); expect(saveButton().textContent).toBe("Update"); await click(saveButton()); expect(posts()).toHaveLength(1);
  });

  it("keeps updates disabled after a failed comparison and retries when the current-file tab is reopened", async () => {
    currentSource = stored.bibtex.replace("Original", "Revised"); await render();
    vi.mocked(api).mockRejectedValueOnce(new Error("Comparison unavailable")); await openCurrent();
    expect(saveButton().disabled).toBe(true); expect(document.querySelector('[role="alert"]')?.textContent).toBe("Comparison unavailable");
    await click(saveButton()); expect(posts()).toHaveLength(0);
    await click([...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')][0]); await tick(); await openCurrent();
    expect(saveButton().disabled).toBe(false); expect(document.querySelector('[role="alert"]')).toBeNull();
  });

  it("aborts and ignores comparison results for old file contents", async () => {
    currentSource = stored.bibtex; await render();
    let finish!: (value: never) => void, oldSignal: AbortSignal | null | undefined;
    vi.mocked(api).mockImplementationOnce((_url, options) => { oldSignal = options?.signal; return new Promise((resolve) => { finish = resolve; }); });
    await openCurrent();
    currentSource = stored.bibtex.replace("Original", "Revised"); await render(); await tick(180);
    expect(oldSignal?.aborted).toBe(true); expect(saveButton().disabled).toBe(false);
    await act(async () => finish({ matches: [{ id: "ref", citationKey: "paper", revision: 1, sameContent: true }] } as never));
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
