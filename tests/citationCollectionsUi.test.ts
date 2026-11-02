// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/client/api";
import { CitationLibraryDialog } from "../src/client/CitationLibraryDialog";
import type { CitationLibraryEntry } from "../src/client/types";
import type { CitationCollectionCatalog } from "../src/shared/citationCollections";
import i18n from "../src/client/i18n";

vi.mock("../src/client/api", async (original) => ({ ...await original<typeof import("../src/client/api")>(), api: vi.fn() }));
let root: Root, host: HTMLDivElement, catalog: CitationCollectionCatalog, saved: CitationLibraryEntry;
const onInsert = vi.fn(), onOpenChange = vi.fn();
const click = (element: HTMLElement) => act(async () => element.click());
const settle = () => act(async () => { vi.advanceTimersByTime(0); });
const buttons = (selector = "button") => [...document.querySelectorAll<HTMLButtonElement>(selector)];
const named = (name: string, selector?: string) => buttons(selector).find((button) => button.textContent === name || button.getAttribute("aria-label") === name)!;
const folder = (name: string) => buttons(".citation-collection-select").find((button) => button.querySelector("span")?.textContent === name)!;
function change(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}
async function menu(trigger: HTMLElement, action: string) {
  await act(async () => trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
  await click([...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) => item.textContent === action)!);
}
async function render(project = false, currentSource = "") {
  await act(async () => root.render(createElement(CitationLibraryDialog, {
    open: true, page: !project, currentFile: project ? "refs.bib" : "", currentSource,
    currentUserId: "alice", maxBibtexBytes: 100_000, onOpenChange, onInsert: project ? onInsert : undefined
  })));
  await settle();
}
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); await i18n.changeLanguage("en");
  onInsert.mockReset().mockResolvedValue(true); onOpenChange.mockReset();
  catalog = { collections: [{ id: "a", name: "Paper A", entryCount: 1 }, { id: "b", name: "Paper B", entryCount: 0 }], total: 1, unfiled: 0 };
  saved = { id: "ref", ownerId: "alice", ownerUsername: "alice", ownerDisplayName: "Alice", citationKey: "paper", entryType: "article",
    title: "A shared reference", authors: "Ada", year: "2026", revision: 1, bibtex: "@article{paper, title={A shared reference}}", tags: [], collectionIds: ["a"], createdAt: "2026-11-02", updatedAt: "2026-11-02" };
  vi.mocked(api).mockReset().mockImplementation(async (url, options) => {
    if (url === "/api/citations/collections") {
      if (options?.method === "POST") {
        const folder = { id: "new", name: JSON.parse(String(options.body)).name, entryCount: 0 };
        catalog = { ...catalog, collections: [...catalog.collections, folder] };
        return { collection: folder } as never;
      }
      return catalog as never;
    }
    if (url.startsWith("/api/citations?")) {
      const params = new URLSearchParams(url.split("?")[1]);
      const id = params.get("collection");
      const entries = !id || (id === "unfiled" ? !saved.collectionIds.length : saved.collectionIds.includes(id)) ? [saved] : [];
      return { entries, pagination: { page: 1, pageSize: 60, total: entries.length, totalPages: entries.length ? 1 : 0 } } as never;
    }
    if (url === "/api/citations/tags") return { tags: [] } as never;
    if (url === "/api/citations/lookup") return { matches: [] } as never;
    if (url === "/api/citations/ref/collections") {
      saved = { ...saved, collectionIds: JSON.parse(String(options?.body)).collectionIds, revision: saved.revision + 1 };
      return { entry: saved } as never;
    }
    if (url.startsWith("/api/citations/collections/")) {
      const id = url.split("/").at(-1)!;
      if (options?.method === "PATCH") catalog = { ...catalog, collections: catalog.collections.map((folder) => folder.id === id ? { ...folder, name: JSON.parse(String(options.body)).name } : folder) };
      if (options?.method === "DELETE") { catalog = { ...catalog, collections: catalog.collections.filter((folder) => folder.id !== id) }; saved = { ...saved, collectionIds: saved.collectionIds.filter((item) => item !== id) }; }
      return { ok: true } as never;
    }
    if (url === "/api/citations" && options?.method === "POST") {
      const body = JSON.parse(String(options.body)); saved = { ...saved, ...body };
      return { entry: saved, updated: false } as never;
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("citation folder workflows", () => {
  it("defaults new entries to the current folder but saves into the destination chosen in the form", async () => {
    await render();
    await click(folder("Paper A")); await settle();
    await click(named("Add entry", ".citation-add-entry-button"));
    const destination = host.querySelector<HTMLSelectElement>('.citation-add-panel select')!;
    expect(destination.value).toBe("a");
    await act(async () => { destination.value = "b"; destination.dispatchEvent(new Event("change", { bubbles: true })); });
    // Changing the form destination must not change the library filter before saving.
    expect(folder("Paper A").getAttribute("aria-current")).toBe("true");
    await act(async () => change(host.querySelector<HTMLTextAreaElement>('.citation-add-panel textarea')!, "@article{new, title={New paper}}"));
    await click(named("Add entry", ".citation-edit-actions button")); await settle();
    const post = vi.mocked(api).mock.calls.find(([url, options]) => url === "/api/citations" && options?.method === "POST")!;
    expect(JSON.parse(String(post[1]?.body))).toMatchObject({ citationKey: "new", collectionIds: ["b"] });
    expect(folder("Paper B").getAttribute("aria-current")).toBe("true");
    expect(host.querySelector(".citation-entry-list")?.textContent).toContain("New paper");
  });

  it("allows adding an unfiled reference when no folders exist", async () => {
    catalog = { collections: [], total: 0, unfiled: 0 };
    await render();
    await click(named("Add entry", ".citation-add-entry-button"));
    const destination = host.querySelector<HTMLSelectElement>('.citation-add-panel select')!;
    expect([...destination.options].map((option) => option.textContent)).toEqual(["Unfiled"]);
    await act(async () => change(host.querySelector<HTMLTextAreaElement>('.citation-add-panel textarea')!, "@misc{unfiled, title={Unfiled reference}}"));
    await click(named("Add entry", ".citation-edit-actions button")); await settle();
    const post = vi.mocked(api).mock.calls.find(([url, options]) => url === "/api/citations" && options?.method === "POST")!;
    expect(JSON.parse(String(post[1]?.body)).collectionIds).toEqual([]);
    expect(folder("All references").getAttribute("aria-current")).toBe("true");
  });

  it("creates and selects a folder, renames it and confirms deletion without deleting the references", async () => {
    await render();
    await click(named("New folder"));
    await act(async () => change(document.querySelector<HTMLInputElement>(".citation-folder-form input")!, "New paper"));
    await click(named("Create", ".dialog-footer button")); await settle();
    expect(folder("New paper").getAttribute("aria-current")).toBe("true");
    const trigger = () => folder("New paper").parentElement!.querySelector<HTMLElement>(".citation-collection-menu-trigger")!;
    await menu(trigger(), "Rename folder");
    await act(async () => change(document.querySelector<HTMLInputElement>(".citation-folder-form input")!, "Renamed"));
    await click(named("Save", ".dialog-footer button")); await settle();
    expect(folder("Renamed").getAttribute("aria-current")).toBe("true");
    expect(host.querySelector(".citation-library-scope-heading a")).toBeNull();
    await menu(folder("Renamed").parentElement!.querySelector<HTMLElement>(".citation-collection-menu-trigger")!, "Delete folder");
    expect(document.body.textContent).toContain("The references inside will remain in your library");
    expect(vi.mocked(api).mock.calls.filter(([, options]) => options?.method === "DELETE")).toHaveLength(0);
    await click(named("Delete", ".dialog-footer button")); await settle();
    expect(folder("Renamed")).toBeUndefined();
    expect(folder("All references").getAttribute("aria-current")).toBe("true");
    expect(host.textContent).toContain("A shared reference");
  });

  it("ignores delayed results from a previously selected folder", async () => {
    await render();
    let resolve!: (value: never) => void, oldSignal: AbortSignal | null | undefined;
    const implementation = vi.mocked(api).getMockImplementation()!;
    vi.mocked(api).mockImplementation((url, options) => {
      if (url.includes("collection=a")) { oldSignal = options?.signal; return new Promise((done) => { resolve = done; }); }
      return implementation(url, options);
    });
    await click(folder("Paper A")); await settle();
    await click(folder("Paper B")); await settle();
    expect(oldSignal?.aborted).toBe(true);
    await act(async () => resolve({ entries: [saved], pagination: { page: 1, pageSize: 60, total: 1, totalPages: 1 } } as never));
    expect(host.querySelector(".citation-entry-card")).toBeNull();
    expect(folder("Paper B").getAttribute("aria-current")).toBe("true");
  });

  it("resets pagination on a folder change and combines it with search and tags without narrowing the export", async () => {
    const implementation = vi.mocked(api).getMockImplementation()!;
    vi.mocked(api).mockImplementation(async (url, options) => {
      if (url === "/api/citations/tags") return { tags: [{ id: "method", ownerId: "alice", name: "Method", color: "blue" }] } as never;
      if (url.startsWith("/api/citations?")) {
        const params = new URLSearchParams(url.split("?")[1]);
        return { entries: [saved], pagination: { page: Number(params.get("page")), pageSize: 60, total: 121, totalPages: 3 } } as never;
      }
      return implementation(url, options);
    });
    await render();
    await click(named("Next", ".citation-library-pagination button")); await settle();
    expect(vi.mocked(api).mock.calls.some(([url]) => url.includes("page=2"))).toBe(true);
    await click(folder("Paper A")); await settle();
    await click(named("Method", ".citation-tag-filters button")); await settle();
    await act(async () => change(host.querySelector<HTMLInputElement>(".citation-library-search input")!, "retrieval"));
    await act(async () => vi.advanceTimersByTime(180));
    const last = vi.mocked(api).mock.calls.filter(([url]) => url.startsWith("/api/citations?")).at(-1)![0];
    const params = new URLSearchParams(last.split("?")[1]);
    expect(Object.fromEntries(params)).toMatchObject({ collection: "a", tag: "method", q: "retrieval", page: "1" });
    expect(host.querySelector(".citation-library-scope-heading a")).toBeNull();
    expect(document.querySelector('a[download]')).toBeNull();
    const trigger = folder("Paper A").parentElement!.querySelector<HTMLElement>(".citation-collection-menu-trigger")!;
    await act(async () => trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    const exportLink = document.querySelector<HTMLAnchorElement>('a[role="menuitem"][download]');
    expect(exportLink?.textContent).toBe("Export BibTeX");
    expect(exportLink?.getAttribute("href")).toBe("/api/citations/collections/a/export");
  });

  it("assigns a reference to multiple folders with unchanged-save protection and the current revision", async () => {
    await render();
    await menu(host.querySelector<HTMLElement>(".citation-entry-menu-trigger")!, "Organize into folders");
    const save = () => document.querySelector<HTMLButtonElement>(".dialog-footer .save-button")!;
    expect(save().disabled).toBe(true);
    const check = (name: string) => [...document.querySelectorAll<HTMLLabelElement>(".citation-collection-choices label")].find((label) => label.textContent === name)!.querySelector<HTMLInputElement>("input")!;
    expect(check("Paper A").checked).toBe(true); expect(check("Paper B").checked).toBe(false);
    await click(check("Paper B")); await click(save());
    expect(save().textContent).toBe("Saved"); expect(save().disabled).toBe(true);
    expect(saved.collectionIds).toEqual(["a", "b"]);
    await settle();
    await click(check("Paper A")); await click(save());
    expect(JSON.parse(String(vi.mocked(api).mock.calls.filter(([url]) => url.endsWith("/ref/collections")).at(-1)?.[1]?.body)).expectedRevision).toBe(2);
    expect(saved.collectionIds).toEqual(["b"]);
  });

  it("filters project imports by folder and passes the selected reference to the existing .bib import workflow", async () => {
    await render(true);
    await click(folder("Paper A")); await settle();
    expect(vi.mocked(api).mock.calls.some(([url]) => url.includes("collection=a"))).toBe(true);
    await click(named("Import", ".citation-entry-actions button"));
    expect(onInsert).toHaveBeenCalledExactlyOnceWith(saved);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("saves a current .bib entry into the chosen folder", async () => {
    await render(true, "@article{newKey, title={New paper}}");
    await click(folder("Paper B")); await settle();
    await click(buttons('[role="tab"]').find((button) => button.textContent?.includes(i18n.t("citationLibrary.currentFile")))!);
    expect(document.querySelector<HTMLSelectElement>(".citation-project-destination select")?.value).toBe("b");
    await act(async () => vi.advanceTimersByTime(180));
    await click(named(i18n.t("citationLibrary.save"), ".citation-entry-actions button"));
    const post = vi.mocked(api).mock.calls.find(([url, options]) => url === "/api/citations" && options?.method === "POST")!;
    expect(JSON.parse(String(post[1]?.body))).toMatchObject({ citationKey: "newKey", collectionIds: ["b"] });
  });
});
