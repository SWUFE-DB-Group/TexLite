// @vitest-environment happy-dom
import { act, createElement, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../src/client/i18n";
import MarkdownPreview, { type MarkdownPreviewHandle } from "../src/client/workspace/MarkdownPreview";
import { displayedPreviewSurface, headingSlugs, isMarkdownPath, resolveMarkdownTarget } from "../src/client/workspace/markdownPreview";
import { useMarkdownPreviewPreference } from "../src/client/workspace/useMarkdownPreviewPreference";

describe("Markdown preview helpers", () => {
  it("recognizes Markdown files by extension", () => {
    expect(["README.md", "docs/Guide.MARKDOWN", "notes.mdown", "a.mkdn"].every(isMarkdownPath)).toBe(true);
    expect(["main.tex", "README", "md", "notes.md.bak"].some(isMarkdownPath)).toBe(false);
  });

  it("shows the Markdown preview only for an active Markdown file that prefers it, and never over diagnostics", () => {
    expect(displayedPreviewSurface("pdf", true, true)).toBe("markdown");
    expect(displayedPreviewSurface("pdf", true, false)).toBe("pdf");
    expect(displayedPreviewSurface("pdf", false, true)).toBe("pdf");
    expect(displayedPreviewSurface("diagnostics", true, true)).toBe("diagnostics");
  });

  it("resolves links from the file's folder or the project root and rejects paths leaving the project", () => {
    expect(resolveMarkdownTarget("docs/guide.md", "images/plot%20one.png?raw=1#x")).toEqual({ kind: "project", path: "docs/images/plot one.png" });
    expect(resolveMarkdownTarget("docs/guide.md", "../main.tex")).toEqual({ kind: "project", path: "main.tex" });
    expect(resolveMarkdownTarget("docs/guide.md", "/figures/a.pdf")).toEqual({ kind: "project", path: "figures/a.pdf" });
    expect(resolveMarkdownTarget("README.md", "./")).toEqual({ kind: "invalid" });
    expect(resolveMarkdownTarget("docs/guide.md", "../../etc/passwd")).toEqual({ kind: "invalid" });
    expect(resolveMarkdownTarget("README.md", "#Getting-Started")).toEqual({ kind: "anchor", id: "Getting-Started" });
    for (const url of ["https://example.org", "mailto:a@example.org", "//cdn.example.org/x.png"]) {
      expect(resolveMarkdownTarget("README.md", url)).toEqual({ kind: "external" });
    }
  });

  it("builds GitHub-style heading ids with suffixes for repeats", () => {
    expect(headingSlugs(["Getting Started!", "API & CLI", "Getting Started", "中文 标题"]))
      .toEqual(["getting-started", "api--cli", "getting-started-1", "中文-标题"]);
  });
});

describe("Markdown preview", () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    window.localStorage.clear();
    await i18n.changeLanguage("en");
    host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  });
  afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  const source = [
    "# Title",              // 1
    "",
    "See [setup](setup.md), [site](https://example.org) and [up](../../x.md).", // 3
    "",
    "![plot](figs/plot.png) ![remote](https://example.org/a.png)", // 5
    "",
    "<script>window.compromised = true</script>", // 7
    "",
    "- item $x^2$", // 9
    "",
    "$$", // 11
    "a = b",
    "$$"
  ].join("\n");

  async function render(props: Partial<Parameters<typeof MarkdownPreview>[0]> = {}) {
    const handlers = { onOpenPath: vi.fn(), onJumpToLine: vi.fn() };
    const ref = createRef<MarkdownPreviewHandle>();
    await act(async () => root.render(createElement(MarkdownPreview, { ref, projectId: "paper", path: "docs/README.md", source, ...handlers, ...props })));
    return { ...handlers, ref };
  }

  it("renders project images and links inside the project, external links in a new tab, and no raw HTML", async () => {
    const { onOpenPath } = await render();
    const images = [...host.querySelectorAll("img")].map((image) => image.getAttribute("src"));
    expect(images).toEqual(["/api/projects/paper/file/raw?path=docs%2Ffigs%2Fplot.png", "https://example.org/a.png"]);
    const setup = host.querySelector<HTMLAnchorElement>("a[href*='setup.md']")!;
    expect(setup.getAttribute("href")).toBe("/api/projects/paper/file/raw?path=docs%2Fsetup.md");
    await act(async () => setup.click());
    expect(onOpenPath).toHaveBeenCalledWith("docs/setup.md");
    expect(host.querySelector("a[href='https://example.org']")?.getAttribute("target")).toBe("_blank");
    expect([...host.querySelectorAll("a")].find((link) => link.textContent === "up")?.hasAttribute("href")).toBe(false);
    expect(host.querySelector("script")).toBeNull();
    expect(host.querySelector(".markdown-equation .katex-display")).not.toBeNull();
  });

  it("maps blocks to source lines for double-click, the visible position, and revealing the cursor", async () => {
    const { onJumpToLine, ref } = await render();
    const lines = [...host.querySelectorAll("[data-source-line]")].map((block) => [block.tagName, block.getAttribute("data-source-line")]);
    expect(lines).toEqual([["H1", "1"], ["P", "3"], ["P", "5"], ["LI", "9"], ["DIV", "11"]]);
    const item = host.querySelector("li")!;
    await act(async () => item.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
    expect(onJumpToLine).toHaveBeenCalledWith(9);

    // The block at the top of the scrolled viewport is the visible position.
    const scroller = host.querySelector<HTMLElement>(".markdown-preview")!;
    const tops = new Map<Element, number>([[scroller, 100], ...[...host.querySelectorAll("[data-source-line]")].map((block, index) => [block, 40 + index * 50] as [Element, number])]);
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      return { top: tops.get(this) ?? 0 } as DOMRect;
    });
    expect(ref.current?.visibleLine()).toBe(3);

    await render({ reveal: { line: 10, nonce: 1 } });
    expect(item.classList.contains("markdown-source-target")).toBe(true);
    expect(scroller.scrollTop).toBe(tops.get(item)! - 100 - 16);
  });

  it("shows an empty state for a blank file", async () => {
    await render({ source: "  \n" });
    expect(host.textContent).toContain("This Markdown file is empty.");
  });

  it("remembers per project in this browser whether Markdown files open in the preview", async () => {
    let current: ReturnType<typeof useMarkdownPreviewPreference>;
    function Probe({ projectId }: { projectId: string }) { current = useMarkdownPreviewPreference("alice", projectId); return null; }
    await act(async () => root.render(createElement(Probe, { projectId: "a" })));
    expect(current![0]).toBe(true);
    await act(async () => current[1](false));
    await act(async () => root.render(createElement(Probe, { projectId: "b" })));
    expect(current![0]).toBe(true);
    await act(async () => root.render(createElement(Probe, { projectId: "a" })));
    expect(current![0]).toBe(false);
  });
});
