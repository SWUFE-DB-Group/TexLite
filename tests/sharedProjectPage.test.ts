// @vitest-environment happy-dom
import { act, createElement, StrictMode, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { api, ApiError } from "../src/client/api";
import { SharedProjectPage } from "../src/client/pages/SharedProjectPage";
import { App } from "../src/client/App";
import type { SharedProjectData } from "../src/shared/projectViewLinks";
import i18n from "../src/client/i18n";

vi.mock("../src/client/api", async (original) => ({ ...await original<typeof import("../src/client/api")>(), api: vi.fn() }));
vi.mock("../src/client/shared/ReadOnlySource", () => ({ ReadOnlySource: ({ content }: { content: string }) => createElement("pre", { className: "test-read-only" }, content) }));
vi.mock("../src/client/PdfPreview", () => ({ PdfPreview: ({ url }: { url: string }) => createElement("div", { className: "test-pdf", "data-url": url }) }));
vi.mock("../src/client/workspacePreload", () => ({ loadProjectWorkspace: vi.fn(), loadPdfPreview: vi.fn(), preloadWorkspace: vi.fn() }));

const id = "11111111-1111-4111-8111-111111111111", endpoint = `/api/shared/${id}`, secret = "a".repeat(43);
let host: HTMLDivElement, root: Root, data: SharedProjectData;
const render = (node: ReactNode = createElement(SharedProjectPage, { linkId: id })) => act(async () => { root.render(node); });
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
const click = (button: HTMLElement) => act(async () => { button.click(); });

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  window.history.replaceState(null, "", `/share/${id}#${secret}`);
  await i18n.changeLanguage("en");
  data = { siteName: "Research TexLite", outline: [{ path: "main.tex", line: 1, level: 1, title: "Introduction" }], project: { name: "Shared research", mainFile: "main.tex", engine: "pdflatex" }, expiresAt: null,
    files: [{ path: "main.tex", type: "file" }, { path: "refs.bib", type: "file" }, { path: "figure.png", type: "file" }],
    pdf: { url: `${endpoint}/pdf?version=one`, size: 123, loadingMode: "full", compiledAt: null } };
  vi.mocked(api).mockReset().mockImplementation(async (url) => {
    if (url.endsWith("/access")) return { ok: true } as never;
    if (url === endpoint) return data as never;
    if (url.includes("/file?path=")) return { path: "main.tex", content: "Read-only source" } as never;
    throw new Error(`Unexpected request ${url}`);
  });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

describe("isolated anonymous reader", () => {
  it("opens from the public App route without authenticating, preloading the workspace or opening a WebSocket", async () => {
    const websocket = vi.fn(); vi.stubGlobal("WebSocket", websocket);
    await render(createElement(App)); await settle(); await settle();
    expect(host.textContent).toContain("Shared research");
    expect(host.querySelector(".test-read-only")?.textContent).toBe("Read-only source");
    expect(host.querySelector(".test-pdf")).not.toBeNull();
    expect(vi.mocked(api).mock.calls.map(([url]) => url)).not.toContain("/api/me");
    expect(vi.mocked(api).mock.calls.every(([url]) => url.startsWith(endpoint))).toBe(true);
    expect(websocket).not.toHaveBeenCalled();
    for (const selector of [".share-action", ".git-action", ".reader-terminal-action", ".compile", ".comments-action", ".snapshots-action"]) {
      expect(host.querySelector<HTMLButtonElement>(selector)?.disabled, selector).toBe(true);
    }
    const requestsBefore = vi.mocked(api).mock.calls.length;
    await act(async () => {
      for (const selector of [".share-action", ".git-action", ".reader-terminal-action", ".compile"]) host.querySelector<HTMLButtonElement>(selector)!.click();
    });
    expect(vi.mocked(api).mock.calls).toHaveLength(requestsBefore);
    expect(host.querySelector(".editor-topbar .site-logo")).not.toBeNull();
    const titleRow = host.querySelector(".project-heading .workspace-project-title-row");
    expect(titleRow?.querySelector(".workspace-project-title")?.textContent).toBe("Shared research");
    expect(titleRow?.querySelector(".shared-reader-access")?.textContent).toBe("Read-only");
    expect(host.querySelectorAll(".shared-reader-access")).toHaveLength(1);
    expect(host.querySelector(".work-grid .left-panel .outline-panel")?.textContent).toContain("Introduction");
  });

  it("uses the ordinary layout menu to switch source/PDF panels without authenticated requests", async () => {
    await render(); await settle();
    const before = vi.mocked(api).mock.calls.length;
    const layoutOption = async (name: string) => {
      await click(host.querySelector<HTMLButtonElement>(".layout-trigger")!);
      await click([...host.querySelectorAll<HTMLButtonElement>(".layout-option")].find((button) => button.querySelector("strong")?.textContent === name)!);
    };
    await layoutOption("Editor only");
    expect(host.querySelector(".source-panel")).not.toBeNull(); expect(host.querySelector(".shared-reader-pdf")).toBeNull();
    await layoutOption("PDF only");
    expect(host.querySelector(".source-panel")).toBeNull(); expect(host.querySelector(".left-panel")).toBeNull();
    expect(host.querySelector(".shared-reader-pdf")).not.toBeNull();
    await layoutOption("Editor & PDF");
    expect(host.querySelector(".source-panel")).not.toBeNull(); expect(host.querySelector(".shared-reader-pdf")).not.toBeNull();
    expect(vi.mocked(api).mock.calls).toHaveLength(before);
    expect(host.querySelector<HTMLAnchorElement>(".pdf-download-top")?.getAttribute("href")).toBe(`${endpoint}/pdf?version=one&download=1`);
  });

  it("supports folder expansion and main-document badges with exactly one selected tree row", async () => {
    data.files.push({ path: "figures", type: "directory" }, { path: "figures/plot.svg", type: "file" });
    await render(); await settle();
    const row = (name: string) => [...host.querySelectorAll<HTMLButtonElement>(".file-entry-main")].find((button) => button.querySelector("span")?.textContent === name)!;
    expect(row("plot.svg")).toBeUndefined();
    await click(row("figures"));
    expect(row("figures").getAttribute("aria-expanded")).toBe("true");
    expect(host.querySelectorAll(".file-entry.active, .file-entry.selected")).toHaveLength(1);
    await click(row("plot.svg"));
    expect(host.querySelectorAll(".file-entry.active, .file-entry.selected")).toHaveLength(1);
    expect(host.querySelector(".file-entry.active")?.textContent).toContain("plot.svg");
    expect(row("main.tex").querySelector("small")?.textContent).toBe(i18n.t("editor.currentMainShort"));
    expect(host.querySelector(".outline-panel")?.textContent).toContain("Introduction");
    expect(host.querySelector(".outline-panel .word-count-actions")).toBeNull();
    await click(row("figures"));
    expect(row("plot.svg")).toBeUndefined();
  });

  it("exchanges the secret in the POST body, removes the fragment, and tolerates StrictMode remounts", async () => {
    await render(createElement(StrictMode, null, createElement(SharedProjectPage, { linkId: id }))); await settle();
    const posts = vi.mocked(api).mock.calls.filter(([, options]) => options?.method === "POST");
    expect(posts.length).toBeGreaterThan(0);
    expect(posts.every(([url, options]) => url === `${endpoint}/access` && JSON.parse(String(options?.body)).token === secret)).toBe(true);
    expect(window.location.hash).toBe("");
    expect(vi.mocked(api).mock.calls.some(([url]) => url.includes(secret))).toBe(false);
    expect(host.querySelector(".test-read-only")).not.toBeNull();
  });

  it("reuses the scoped cookie after reload without a secret in browser storage", async () => {
    window.history.replaceState(null, "", `/share/${id}`);
    await render(); await settle();
    expect(vi.mocked(api).mock.calls.some(([, options]) => options?.method === "POST")).toBe(false);
    expect(host.querySelector(".test-read-only")).not.toBeNull();
    expect(window.localStorage.getItem(`texlite_view_${id}`)).toBeNull();
  });

  it("exchanges a rotated fragment opened in the same tab, even after the previous grant expired", async () => {
    vi.mocked(api).mockRejectedValueOnce(new ApiError("expired", 410, "VIEW_LINK_INVALID"));
    await render(); await settle();
    expect(host.querySelector(".shared-reader-workspace")).toBeNull();
    const next = "b".repeat(43);
    await act(async () => {
      window.history.replaceState(null, "", `/share/${id}#${next}`);
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    await settle();
    const posts = vi.mocked(api).mock.calls.filter(([, options]) => options?.method === "POST");
    expect(JSON.parse(String(posts.at(-1)?.[1]?.body))).toEqual({ token: next });
    expect(window.location.hash).toBe(""); expect(host.querySelector(".test-read-only")).not.toBeNull();
  });

  it("clears content/PDF on expiry and stops accepting late results", async () => {
    data.expiresAt = new Date(Date.now() + 1000).toISOString();
    await render(); await settle();
    expect(host.querySelector(".test-pdf")).not.toBeNull();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1050)); });
    expect(host.querySelector(".test-pdf")).toBeNull(); expect(host.querySelector(".test-read-only")).toBeNull();
    expect(host.textContent).toContain("This link is no longer available");
  });

  it("checks revocation while visible, without repeatedly listing files or refreshing source", async () => {
    await render(); await settle();
    const metadataCalls = vi.mocked(api).mock.calls.filter(([url]) => url === endpoint).length;
    vi.mocked(api).mockImplementation(async (url) => {
      if (url === `${endpoint}/access`) throw new ApiError("revoked", 410, "VIEW_LINK_INVALID");
      throw new Error("Should check only the grant");
    });
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
    expect(host.querySelector(".test-pdf")).toBeNull();
    expect(host.textContent).toContain("This link is no longer available");
    expect(vi.mocked(api).mock.calls.filter(([url]) => url === endpoint)).toHaveLength(metadataCalls);
  });

  it("aborts switched-file requests and ignores their late source", async () => {
    await render(); await settle();
    let resolve!: (value: never) => void, oldSignal: AbortSignal | null | undefined;
    vi.mocked(api).mockImplementation((url, options) => {
      if (url.includes("refs.bib")) { oldSignal = options?.signal; return new Promise((done) => { resolve = done; }); }
      return Promise.resolve({ path: "main.tex", content: "Current source" } as never);
    });
    const file = (name: string) => [...host.querySelectorAll<HTMLButtonElement>(".shared-reader-files button")].find((button) => button.querySelector("span")?.textContent === name)!;
    await click(file("refs.bib")); await click(file("main.tex"));
    expect(oldSignal?.aborted).toBe(true);
    await act(async () => resolve({ path: "refs.bib", content: "Stale source" } as never));
    expect(host.textContent).toContain("Current source"); expect(host.textContent).not.toContain("Stale source");
  });

  it("keeps language/theme controls available on an expired link without showing private content", async () => {
    vi.mocked(api).mockRejectedValue(new ApiError("expired", 410, "VIEW_LINK_INVALID"));
    await render(); await settle();
    await click([...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Settings")!);
    expect(document.querySelector(".shared-reader-settings select")).not.toBeNull();
    expect(document.querySelector(".shared-reader-settings .theme-switcher")).not.toBeNull();
    expect(host.querySelector(".shared-reader-workspace")).toBeNull();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Ask the project owner");
  });
});
