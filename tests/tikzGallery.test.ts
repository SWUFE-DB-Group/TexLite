// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../src/client/i18n";
import { TikzGalleryDialog } from "../src/client/tikzGallery/TikzGalleryDialog";
import { filterTikzGallery, tikzGalleryDestination, type TikzGalleryItem } from "../src/client/tikzGallery/catalog";

const item = (id: string, type: TikzGalleryItem["type"], extra: Partial<TikzGalleryItem> = {}): TikzGalleryItem => ({
  id, name: id, type, domain: [], tags: [], description: "", requires: [], featured: false, tex: `${id}/${id}.tex`, preview: `${id}/${id}.svg`, ...extra
});

describe("TikZ gallery catalog", () => {
  it("filters by type and by every word of the query", () => {
    const sample = [item("gpu", "icon", { category: "systems", tags: ["hardware"] }), item("resnet", "template", { domain: ["ml"], description: "residual block" }), item("cloud", "icon", { category: "systems" }), item("github", "icon", { category: "brands" })];
    expect(filterTikzGallery(sample, "icon", "systems", "").map(({ id }) => id)).toEqual(["gpu", "cloud"]);
    expect(filterTikzGallery(sample, "icon", "brands", "").map(({ id }) => id)).toEqual(["github"]);
    // The icon category does not narrow other types.
    expect(filterTikzGallery(sample, "template", "brands", "RESIDUAL block").map(({ id }) => id)).toEqual(["resnet"]);
    expect(filterTikzGallery(sample, "icon", "systems", "hardware residual")).toEqual([]);
    // A search covers every icon category; blank input is still browsing.
    expect(filterTikzGallery(sample, "icon", "systems", "github").map(({ id }) => id)).toEqual(["github"]);
    expect(filterTikzGallery(sample, "icon", "brands", "   ").map(({ id }) => id)).toEqual(["github"]);
    expect(filterTikzGallery(sample, "template", "brands", "github")).toEqual([]);
  });

  it("proposes a path in the selected folder or figures/", () => {
    expect(tikzGalleryDestination(item("gpu", "icon"), null)).toBe("figures/gpu.tex");
    expect(tikzGalleryDestination(item("gpu", "icon"), "img/icons")).toBe("img/icons/gpu.tex");
  });
});

describe("TikZ gallery dialog", () => {
  let host: HTMLDivElement;
  let root: Root;
  const onClose = vi.fn();
  const onImport = vi.fn();

  beforeEach(async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    onClose.mockReset(); onImport.mockReset();
    await i18n.changeLanguage("en");
    vi.stubGlobal("fetch", vi.fn(async (url: string) => String(url).endsWith("/api/tikz-gallery/catalog")
      ? Response.json({ attribution: { url: "javascript:alert(1)", text: { en: "Hostile" } }, categories: [{ id: "systems", label: { en: "Systems" } }, { id: "ml", label: { en: "Machine learning" } }, { id: "brands", label: { en: "Brands" }, trademark: true }], items: [item("gpu", "icon", { category: "systems" }), item("github", "icon", { category: "brands" }), item("resnet", "template")] })
      : new Response("\\documentclass[tikz]{standalone}")));
    host = document.createElement("div"); document.body.append(host); root = createRoot(host);
    await act(async () => root.render(createElement(TikzGalleryDialog, { folder: null, onClose, onImport })));
    await act(async () => { await Promise.resolve(); });
  });
  afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

  const card = (name: string) => [...document.querySelectorAll<HTMLButtonElement>(".tikz-gallery-card")].find((button) => button.textContent === name)!;
  const submit = () => act(async () => document.querySelector<HTMLFormElement>(".tikz-gallery-import")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));

  it("opens on templates and switches type without an all-types view", async () => {
    const types = [...document.querySelectorAll<HTMLButtonElement>(".tikz-gallery-types button")];
    expect(types.map((button) => button.textContent)).toEqual(["Templates", "Examples", "Icons", "Data plots"]);
    expect(card("resnet")).toBeDefined();
    expect(card("gpu")).toBeUndefined();
    expect(document.querySelector(".tikz-gallery-categories")).toBeNull();
    await act(async () => types[2]!.click());
    expect(card("gpu")).toBeDefined();
    expect(card("resnet")).toBeUndefined();
  });

  it("groups icons by category, starting from systems", async () => {
    await act(async () => document.querySelectorAll<HTMLButtonElement>(".tikz-gallery-types button")[2]!.click());
    const categories = [...document.querySelectorAll<HTMLButtonElement>(".tikz-gallery-categories button")];
    expect(categories.map((button) => button.textContent)).toEqual(["Systems", "Machine learning", "Brands"]);
    expect(card("github")).toBeUndefined();
    await act(async () => categories[2]!.click());
    expect(card("github")).toBeDefined();
    expect(card("gpu")).toBeUndefined();
  });

  it("searches every icon category and returns to browsing when a category is chosen", async () => {
    await act(async () => document.querySelectorAll<HTMLButtonElement>(".tikz-gallery-types button")[2]!.click());
    const search = document.querySelector<HTMLInputElement>(".tikz-gallery-search input")!;
    const categories = [...document.querySelectorAll<HTMLButtonElement>(".tikz-gallery-categories button")];
    expect(categories[0]!.getAttribute("aria-pressed")).toBe("true");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, "github");
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(card("github")).toBeDefined();
    expect(categories.map((button) => button.getAttribute("aria-pressed"))).toEqual(["false", "false", "false"]);
    await act(async () => categories[1]!.click());
    expect(search.value).toBe("");
    expect(card("github")).toBeUndefined();
    expect(categories[1]!.getAttribute("aria-pressed")).toBe("true");
  });

  it("copies the selected figure's source to the proposed path and closes", async () => {
    await act(async () => card("resnet").click());
    expect(document.querySelector<HTMLInputElement>(".tikz-gallery-import input")!.value).toBe("figures/resnet.tex");
    await submit();
    expect(onImport).toHaveBeenCalledWith("figures/resnet.tex", "\\documentclass[tikz]{standalone}");
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("stays open and shows why when the file cannot be created", async () => {
    onImport.mockRejectedValueOnce(new Error("A file with this name already exists."));
    await act(async () => card("resnet").click());
    await submit();
    expect(document.querySelector(".tikz-gallery-error")?.textContent).toContain("already exists");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("ignores an attribution link that is not https", () => {
    expect(document.querySelector(".tikz-gallery-attribution")).toBeNull();
  });

  it("does nothing until a figure is chosen", async () => {
    expect(document.querySelector<HTMLButtonElement>(".tikz-gallery-import button")!.disabled).toBe(true);
    await submit();
    expect(onImport).not.toHaveBeenCalled();
  });
});
