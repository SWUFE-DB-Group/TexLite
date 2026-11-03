// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/client/api";
import { CitationLibraryDialog } from "../src/client/CitationLibraryDialog";
import type { CitationLibraryEntry } from "../src/client/types";
import type { CitationCollectionCatalog } from "../src/shared/citationCollections";
import i18n from "../src/client/i18n";
import { replaceCitationBibtex } from "./helpers/citationEditor";

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
  vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1)); vi.stubGlobal("cancelAnimationFrame", vi.fn());
  await import("../src/client/CitationBibtexEditor");
  onInsert.mockReset().mockResolvedValue(true); onOpenChange.mockReset();
  catalog = { collections: [{ id: "a", name: "Paper A", entryCount: 1 }, { id: "b", name: "Paper B", entryCount: 0 }], total: 1, unfiled: 0 };
  saved = { id: "ref", ownerId: "alice", ownerUsername: "alice", ownerDisplayName: "Alice", citationKey: "paper", entryType: "article",
    title: "A shared reference", authors: "Ada", year: "2026", revision: 1, bibtex: "@article{paper, title={A shared reference}}", notes: "", tags: [], collectionIds: ["a"], createdAt: "2026-11-02", updatedAt: "2026-11-02" };
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
    if (url === "/api/citations/ref" && options?.method === "PATCH") {
      saved = { ...saved, ...JSON.parse(String(options.body)), revision: saved.revision + 1 };
      return { entry: saved } as never;
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("citation folder workflows", () => {
  it("submits optional Markdown notes with the BibTeX entry, not inside the BibTeX text", async () => {
    await render();
    await click(named("Add entry", ".citation-add-entry-button"));
    const notes = host.querySelector<HTMLTextAreaElement>(".citation-notes-input")!;
    await act(async () => replaceCitationBibtex(host, "@article{new, title={New paper}}"));
    await click(named("Notes", '.citation-content-tabs [role="tab"]'));
    await act(async () => change(notes, "## Reading notes\n\n**Useful** result."));
    await click(named("Add entry", ".citation-edit-actions button")); await settle();
    const post = vi.mocked(api).mock.calls.find(([url, options]) => url === "/api/citations" && options?.method === "POST")!;
    expect(JSON.parse(String(post[1]?.body))).toMatchObject({ bibtex: "@article{new, title={New paper}}", notes: "## Reading notes\n\n**Useful** result." });
    expect(host.querySelector(".citation-add-panel")).toBeNull();
  });

  it("keeps Save disabled until BibTeX or notes change, handles reverting changes and displays saved Markdown from the overflow menu", async () => {
    await render();
    await menu(host.querySelector<HTMLElement>(".citation-entry-menu-trigger")!, "Edit");
    const save = () => document.querySelector<HTMLButtonElement>(".citation-edit-actions .save-button")!;
    const notes = document.querySelector<HTMLTextAreaElement>(".citation-notes-input")!;
    expect(save().disabled).toBe(true);
    await act(async () => replaceCitationBibtex(document, "@article{paper, title={Edited}}"));
    expect(save().disabled).toBe(false);
    await act(async () => replaceCitationBibtex(document, saved.bibtex));
    expect(save().disabled).toBe(true);
    await click(named("Notes", '.citation-content-tabs [role="tab"]'));
    await act(async () => change(notes, "## Result\n\n**Important** findings."));
    expect(save().disabled).toBe(false);
    await act(async () => change(notes, ""));
    expect(save().disabled).toBe(true);
    await act(async () => change(notes, "## Result\n\n**Important** findings."));
    await click(save()); await settle();
    expect(saved.notes).toBe("## Result\n\n**Important** findings.");
    expect(save().disabled).toBe(true);
    expect(save().textContent).toBe("Saved");
    await click(named("Cancel", ".citation-edit-actions button"));
    await menu(host.querySelector<HTMLElement>(".citation-entry-menu-trigger")!, "Show notes");
    await act(async () => { await import("../src/client/CitationNotesPreview"); });
    const item = host.querySelector(".citation-entry-item")!;
    expect(item.querySelector(".citation-entry-notes .citation-notes-markdown h2")?.textContent).toBe("Result");
    expect(item.querySelector(".citation-entry-notes .citation-notes-markdown strong")?.textContent).toBe("Important");
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await menu(host.querySelector<HTMLElement>(".citation-entry-menu-trigger")!, "Hide notes");
    expect(item.querySelector(".citation-entry-notes")).toBeNull();
  });

  it("expands notes independently below each entry, uses fresh entry data after a list reload and closes without a modal", async () => {
    saved = { ...saved, notes: "## First notes\n\n$E=mc^2$" };
    const other = { ...saved, id: "other", citationKey: "second", notes: "" };
    const implementation = vi.mocked(api).getMockImplementation()!;
    vi.mocked(api).mockImplementation(async (url, options) => url.startsWith("/api/citations?")
      ? { entries: [saved, other], pagination: { page: 1, pageSize: 60, total: 2, totalPages: 1 } } as never : implementation(url, options));
    await render();
    const rows = () => [...host.querySelectorAll<HTMLElement>(".citation-entry-item")];
    for (const row of rows()) await menu(row.querySelector<HTMLElement>(".citation-entry-menu-trigger")!, "Show notes");
    await act(async () => { await import("../src/client/CitationNotesPreview"); });
    expect(rows()[0].querySelector(".citation-entry-notes .katex")).not.toBeNull();
    expect(rows()[1].querySelector(".citation-entry-notes")?.textContent).toContain("No notes yet.");
    expect(host.querySelectorAll('.citation-entry-notes-content[role="region"][tabindex="0"]')).toHaveLength(2);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    saved = { ...saved, notes: "## Updated notes" };
    await click(folder("Paper A")); await settle();
    expect(rows()[0].querySelector(".citation-entry-notes h2")?.textContent).toBe("Updated notes");
    expect(rows()[1].querySelector(".citation-entry-notes")).not.toBeNull();
    await click(rows()[0].querySelector<HTMLElement>('.citation-entry-notes-heading [aria-label="Hide notes"]')!);
    expect(rows()[0].querySelector(".citation-entry-notes")).toBeNull();
    expect(rows()[1].querySelector(".citation-entry-notes")).not.toBeNull();
  });

  it("previews a folder file before import, prevents duplicate submission and selects the imported folder with filters reset", async () => {
    const implementation = vi.mocked(api).getMockImplementation()!;
    let finish!: () => void;
    vi.mocked(api).mockImplementation((url, options) => url === "/api/citations/collections/import" ? new Promise((resolve) => {
      finish = () => {
        const collection = { id: "imported", name: "Personal reading", entryCount: 1 };
        catalog = { ...catalog, collections: [...catalog.collections, collection] };
        saved = { ...saved, collectionIds: [...saved.collectionIds, collection.id] };
        resolve({ collection, imported: 1 } as never);
      };
    }) : implementation(url, options));
    await render();
    await click(named("Import", ".citation-collection-import button"));
    const submit = () => document.querySelector<HTMLButtonElement>(".dialog-footer .save-button")!;
    expect(submit().disabled).toBe(true);
    const input = document.querySelector<HTMLInputElement>('.citation-folder-import input[type="file"]')!;
    const contents = { format: "texlite-citation-folder", version: 1, name: "Ignore this embedded name", entries: [{ ...saved, notes: "**Shared**" }] };
    Object.defineProperty(input, "files", { configurable: true, value: [new File([JSON.stringify(contents)], "Paper A.texlite-citations.json", { type: "application/json" })] });
    await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
    const name = document.querySelector<HTMLInputElement>('.citation-folder-import input[type="text"]')!;
    expect(name.value).toBe("Paper A.texlite-citations");
    expect(document.querySelector(".citation-folder-import")?.textContent).toContain("Paper A.texlite-citations · 1 entry");
    expect(submit().disabled).toBe(false);
    await act(async () => change(name, "  "));
    expect(submit().disabled).toBe(true);
    await act(async () => change(name, " Personal reading "));
    expect(submit().disabled).toBe(false);
    expect(vi.mocked(api).mock.calls.filter(([url]) => url.endsWith("/import"))).toHaveLength(0);
    await click(submit()); await click(submit());
    const imports = vi.mocked(api).mock.calls.filter(([url]) => url.endsWith("/import"));
    expect(imports).toHaveLength(1);
    expect(name.disabled).toBe(true);
    expect(JSON.parse(String(imports[0][1]?.body)).name).toBe("Personal reading");
    const importedEntry = JSON.parse(String(imports[0][1]?.body)).entries[0];
    expect(importedEntry).toMatchObject({ citationKey: "paper", notes: "**Shared**" });
    expect(importedEntry).not.toHaveProperty("tags");
    expect(importedEntry).not.toHaveProperty("collectionIds");
    await act(async () => finish()); await settle();
    expect(document.querySelector(".citation-folder-import")).toBeNull();
    expect(folder("Personal reading").getAttribute("aria-current")).toBe("true");
    expect(host.querySelector(".citation-entry-list")?.textContent).toContain(saved.title);
  });

  it("leaves the library untouched when an invalid folder file is chosen and allows choosing another file", async () => {
    await render(); await click(named("Import", ".citation-collection-import button"));
    const input = document.querySelector<HTMLInputElement>('.citation-folder-import input[type="file"]')!;
    for (const contents of ["not json", JSON.stringify({ format: "texlite-citation-folder", version: 2, name: "New", entries: [] }),
      JSON.stringify({ format: "texlite-citation-folder", version: 1, name: "New", entries: [{ ...saved, bibtex: "@article{unclosed", notes: "" }] })]) {
      Object.defineProperty(input, "files", { configurable: true, value: [new File([contents], "invalid.json")] });
      await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
      expect(document.querySelector('[role="alert"]')?.textContent).toContain("Choose a valid .bib");
      expect(document.querySelector<HTMLButtonElement>(".dialog-footer .save-button")?.disabled).toBe(true);
      expect(input.disabled).toBe(false);
    }
    expect(vi.mocked(api).mock.calls.filter(([, options]) => options?.method === "POST")).toHaveLength(0);
  });

  it("keeps a user-entered folder name when file reading finishes later", async () => {
    await render(); await click(named("Import", ".citation-collection-import button"));
    let finish!: (value: string) => void;
    const file = new File([], "Original.json");
    vi.spyOn(file, "text").mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const input = document.querySelector<HTMLInputElement>('.citation-folder-import input[type="file"]')!;
    Object.defineProperty(input, "files", { configurable: true, value: [file] });
    await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
    const name = document.querySelector<HTMLInputElement>('.citation-folder-import input[type="text"]')!;
    expect(name.value).toBe("Original");
    await act(async () => change(name, "My folder"));
    await act(async () => finish(JSON.stringify({ format: "texlite-citation-folder", version: 1, entries: [{ bibtex: saved.bibtex, notes: "Notes" }] })));
    expect(name.value).toBe("My folder");
    expect(document.querySelector<HTMLButtonElement>(".dialog-footer .save-button")?.disabled).toBe(false);
    expect(document.querySelector(".citation-folder-import")?.textContent).toContain("My folder · 1 entry");
  });

  it("explains imports beside the folder list and supports browsing, dropping, clearing and replacing a selected file", async () => {
    await render();
    await click(named("About importing citations"));
    expect(document.querySelector(".info-popover-content")?.textContent).toContain("Tags are not exported or imported");
    await click(named("About importing citations"));
    await click(named("Import", ".citation-collection-import button"));
    const input = document.querySelector<HTMLInputElement>('.citation-folder-import input[type="file"]')!;
    const browse = vi.spyOn(input, "click");
    await click(named("Browse files"));
    expect(browse).toHaveBeenCalledOnce();
    const picker = document.querySelector<HTMLElement>(".citation-folder-import .upload-picker")!;
    const drop = async (files: File[]) => {
      const event = new Event("drop", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "dataTransfer", { value: { files } });
      await act(async () => picker.dispatchEvent(event));
      expect(event.defaultPrevented).toBe(true);
    };
    await drop([new File(["@article{first, title={First}}\n@book{second, title={Second}}"], "Reading.BIB")]);
    expect(picker.textContent).toContain("Reading.BIB");
    expect(document.querySelector(".citation-folder-import")?.textContent).toContain("Reading · 2 entries");
    expect(document.querySelector<HTMLInputElement>('.citation-folder-import input[type="text"]')?.value).toBe("Reading");
    const submit = () => document.querySelector<HTMLButtonElement>(".dialog-footer .save-button")!;
    expect(submit().disabled).toBe(false);
    await click(named("Clear selected file"));
    expect(submit().disabled).toBe(true);
    expect(picker.textContent).not.toContain("Reading.BIB");
    expect(document.querySelector('.citation-folder-import input[type="text"]')).toBeNull();
    await drop([new File([saved.bibtex], "one.bib"), new File([saved.bibtex], "two.bib")]);
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("one .bib or .json");
    expect(submit().disabled).toBe(true);
    await drop([new File([saved.bibtex], "Final.bib")]);
    // Hold the request so the payload can be checked without refreshing fixture data.
    vi.mocked(api).mockImplementationOnce(() => new Promise(() => {}));
    await click(submit());
    const call = vi.mocked(api).mock.calls.find(([url]) => url.endsWith("/import"))!;
    expect(JSON.parse(String(call[1]?.body))).toMatchObject({ name: "Final", entries: [{ citationKey: "paper", notes: "" }] });
  });
  it("defaults new entries to the current folder but saves into the destination chosen in the form", async () => {
    await render();
    await click(folder("Paper A")); await settle();
    await click(named("Add entry", ".citation-add-entry-button"));
    const destination = host.querySelector<HTMLSelectElement>('.citation-add-panel select')!;
    expect(destination.value).toBe("a");
    await act(async () => { destination.value = "b"; destination.dispatchEvent(new Event("change", { bubbles: true })); });
    // Changing the form destination must not change the library filter before saving.
    expect(folder("Paper A").getAttribute("aria-current")).toBe("true");
    await act(async () => replaceCitationBibtex(host, "@article{new, title={New paper}}"));
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
    await act(async () => replaceCitationBibtex(host, "@misc{unfiled, title={Unfiled reference}}"));
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
    expect(document.querySelector<HTMLInputElement>(".citation-folder-delete-option input")?.checked).toBe(false);
    expect(document.body.textContent).toContain("The references inside will remain in your library");
    expect(vi.mocked(api).mock.calls.filter(([, options]) => options?.method === "DELETE")).toHaveLength(0);
    await click(named("Delete", ".dialog-footer button")); await settle();
    expect(folder("Renamed")).toBeUndefined();
    expect(folder("All references").getAttribute("aria-current")).toBe("true");
    expect(host.textContent).toContain("A shared reference");
  });

  it("requires an explicit checkbox for deleting references, resets it on reopening, and keeps the dialog on failure", async () => {
    await render();
    const open = async () => menu(folder("Paper A").parentElement!.querySelector<HTMLElement>(".citation-collection-menu-trigger")!, "Delete folder");
    const checkbox = () => document.querySelector<HTMLInputElement>(".citation-folder-delete-option input")!;
    await open();
    expect(checkbox().checked).toBe(false);
    await click(checkbox());
    expect(document.body.textContent).toContain("References in other folders will be kept");
    await click(named("Cancel", ".dialog-footer button"));
    expect(vi.mocked(api).mock.calls.some(([, options]) => options?.method === "DELETE")).toBe(false);
    await open();
    expect(checkbox().checked).toBe(false);
    await click(checkbox());
    const implementation = vi.mocked(api).getMockImplementation()!;
    let fail!: (reason: Error) => void;
    vi.mocked(api).mockImplementation((url, options) => options?.method === "DELETE" ? new Promise((_resolve, reject) => { fail = reject; }) : implementation(url, options));
    const submit = named("Delete", ".dialog-footer button");
    await click(submit); await click(submit);
    expect(checkbox().disabled).toBe(true);
    const deletions = vi.mocked(api).mock.calls.filter(([, options]) => options?.method === "DELETE");
    expect(deletions).toHaveLength(1);
    expect(deletions[0][0]).toBe("/api/citations/collections/a?deleteReferences=true");
    await act(async () => fail(new Error("Delete failed")));
    expect(document.querySelector(".dialog-error")?.textContent).toBe("Delete failed");
    expect(checkbox().checked).toBe(true);
    expect(checkbox().disabled).toBe(false);
    expect(folder("Paper A")).toBeDefined();
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
    const notesExport = [...document.querySelectorAll<HTMLAnchorElement>('a[role="menuitem"][download]')].find((link) => link.textContent === "Export BibTeX with notes");
    expect(notesExport?.getAttribute("href")).toBe("/api/citations/collections/a/export?notes=true");
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
