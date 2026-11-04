// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectSearchDialog } from "../src/client/ProjectSearchDialog";
import { api } from "../src/client/api";
import i18n from "../src/client/i18n";
import type { ProjectSearchResult } from "../src/shared/projectSearch";

vi.mock("../src/client/api", () => ({ api: vi.fn() }));
let host: HTMLDivElement, root: Root;
const navigate = vi.fn(), close = vi.fn();
const result: ProjectSearchResult = { matches: [
  { path: "chapters/intro.tex", line: 3, column: 7, from: 26, to: 29, preview: "\\cite{key}", matchStart: 6, matchEnd: 9, sourceHash: "a".repeat(64) },
  { path: "library.bib", line: 1, column: 10, from: 9, to: 12, preview: "@article{key,", matchStart: 9, matchEnd: 12, sourceHash: "b".repeat(64) }
], limited: false };
const input = () => document.querySelector<HTMLInputElement>(".project-search-input input")!;
async function enter(query: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input(), query);
    input().dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function enterReplacement(value: string) {
  await act(async () => {
    const element = document.querySelector<HTMLInputElement>(".project-replace-input input")!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const advance = () => act(async () => { await vi.advanceTimersByTimeAsync(350); });
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); vi.useFakeTimers();
  vi.mocked(api).mockReset(); navigate.mockReset(); close.mockReset();
  await i18n.changeLanguage("en");
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(createElement(ProjectSearchDialog, { projectId: "project", onClose: close, onNavigate: navigate })));
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); vi.unstubAllGlobals();
});

describe("project search dialog", () => {
  it("disables identical case-sensitive replacements but permits case normalization when case matching is off", async () => {
    vi.mocked(api).mockResolvedValueOnce(result);
    await enter("key"); await advance(); await enterReplacement("key");
    const all = document.querySelector<HTMLButtonElement>(".project-replace-all")!;
    const rows = () => [...document.querySelectorAll<HTMLButtonElement>(".project-replace-match")];
    expect(all.disabled).toBe(true); expect(rows().every((button) => button.disabled)).toBe(true);
    await act(async () => { all.click(); rows()[0].click(); });
    expect(api).toHaveBeenCalledTimes(1);
    await enterReplacement("KEY");
    expect(all.disabled).toBe(false); expect(rows().every((button) => !button.disabled)).toBe(true);
    await enterReplacement("key");
    vi.mocked(api).mockResolvedValueOnce({ ...result, matches: [result.matches[0], { ...result.matches[1], preview: "@article{KEY," }] });
    await act(async () => document.querySelector<HTMLButtonElement>('.project-search-input button[aria-pressed]')!.click());
    await advance();
    expect(all.disabled).toBe(false);
    expect(rows().map((button) => button.disabled)).toEqual([true, false]);
    expect(vi.mocked(api).mock.calls.every(([url]) => !url.endsWith("/replace"))).toBe(true);
  });

  it("debounces, groups matches and navigates to an unopened source with case and word options", async () => {
    vi.mocked(api).mockResolvedValue(result);
    await enter("key"); expect(api).not.toHaveBeenCalled(); await advance();
    expect(api).toHaveBeenLastCalledWith("/api/projects/project/search", expect.objectContaining({ method: "POST", body: JSON.stringify({ query: "key", caseSensitive: true, wholeWord: true }) }));
    expect([...document.querySelectorAll(".project-search-results summary > span")].map((node) => node.textContent)).toEqual(["chapters/intro.tex", "library.bib"]);
    expect(document.querySelector(".project-search-summary")!.textContent).toContain("2 matches");
    expect([...document.querySelectorAll(".project-search-match mark")].map((node) => node.textContent)).toEqual(["key", "key"]);
    for (const button of document.querySelectorAll<HTMLButtonElement>(".project-search-input button")) await act(async () => button.click());
    await advance();
    expect(JSON.parse(vi.mocked(api).mock.calls.at(-1)![1]!.body as string)).toEqual({ query: "key", caseSensitive: false, wholeWord: false });
    await act(async () => document.querySelector<HTMLButtonElement>(".project-search-match")!.click());
    expect(navigate).toHaveBeenCalledWith("chapters/intro.tex", 3, 7); expect(close).toHaveBeenCalledOnce();
  });

  it("aborts obsolete requests and never shows their late results or errors", async () => {
    let finish!: (value: ProjectSearchResult) => void;
    vi.mocked(api).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve as typeof finish; }));
    await enter("old"); await advance();
    const signal = vi.mocked(api).mock.calls[0][1]!.signal!;
    vi.mocked(api).mockResolvedValue({ matches: [], limited: false });
    await enter("new"); expect(signal.aborted).toBe(true); await advance();
    await act(async () => finish(result));
    expect(document.querySelectorAll(".project-search-match")).toHaveLength(0);
    expect(document.querySelector(".project-search-empty")!.textContent).toContain(i18n.t("projectSearch.noMatches"));
    await enter(""); await advance(); expect(api).toHaveBeenCalledTimes(2);
    expect(document.querySelector(".project-search-empty")!.textContent).toContain(i18n.t("projectSearch.empty"));
  });

  it("shows failures, retries and explains truncated results without injecting matched source as HTML", async () => {
    vi.mocked(api).mockRejectedValueOnce(new Error("Search unavailable"));
    await enter("<img>"); await advance();
    expect(document.querySelector('[role="alert"]')!.textContent).toContain("Search unavailable");
    vi.mocked(api).mockResolvedValue({ matches: [{ ...result.matches[0], preview: "<img>", matchStart: 0, matchEnd: 5 }], limited: true });
    await act(async () => document.querySelector<HTMLButtonElement>(".project-search-error button")!.click()); await advance();
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(document.querySelector(".project-search-limit")!.textContent).toBe(i18n.t("projectSearch.limited"));
    expect(document.querySelector(".project-search-match mark")!.textContent).toBe("<img>");
    expect(document.querySelector(".project-search-match img")).toBeNull();
  });

  it("shows separate occurrences on the same line and replaces only the selected match once", async () => {
    const line = { ...result.matches[0], preview: "key key", column: 1, from: 20, to: 23, matchStart: 0, matchEnd: 3 };
    const matches = [line, { ...line, column: 5, from: 24, to: 27, matchStart: 4, matchEnd: 7 }, result.matches[1]];
    let finish!: (value: unknown) => void;
    vi.mocked(api).mockResolvedValueOnce({ matches, limited: false });
    await enter("key"); await advance();
    expect(document.querySelectorAll(".project-search-row")).toHaveLength(3);
    expect([...document.querySelectorAll(".project-search-line")].map((node) => node.textContent)).toEqual(["L3:1", "L3:5", "L1:10"]);
    expect(document.querySelectorAll(".project-search-match del, .project-search-match ins")).toHaveLength(0);
    await enterReplacement("new-key");
    const firstRow = document.querySelectorAll(".project-search-row")[0];
    const secondRow = document.querySelectorAll(".project-search-row")[1];
    expect(firstRow.querySelector("code")!.textContent).toBe("keynew-key key");
    expect(secondRow.querySelector("code")!.textContent).toBe("key keynew-key");
    expect([...document.querySelectorAll(".project-search-match del")].map((node) => node.textContent)).toEqual(["key", "key", "key"]);
    expect([...document.querySelectorAll(".project-search-match ins")].map((node) => node.textContent)).toEqual(["new-key", "new-key", "new-key"]);
    await enterReplacement(""); expect(document.querySelector(".project-search-match del")).toBeNull();
    await enterReplacement("new-key");
    vi.mocked(api).mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    const button = document.querySelectorAll<HTMLButtonElement>(".project-replace-match")[1];
    await act(async () => { button.click(); button.click(); });
    expect(api).toHaveBeenCalledTimes(2);
    expect(JSON.parse(vi.mocked(api).mock.calls[1][1]!.body as string)).toMatchObject({ replacement: "new-key", targets: [{ path: line.path, sourceHash: line.sourceHash, ranges: [{ from: 24, to: 27 }] }] });
    expect(input().disabled).toBe(true);
    vi.mocked(api).mockResolvedValue({ matches: [], limited: false });
    await act(async () => finish({ replaced: 1, files: 1 })); await advance();
    expect(document.querySelector(".project-replace-notice")!.textContent).toBe(i18n.t("projectSearch.replaced", { count: 1 }));
    expect(close).not.toHaveBeenCalled(); expect(input().disabled).toBe(false);
    expect(document.querySelectorAll(".project-search-match")).toHaveLength(0);
  });

  it("confirms all replacements, requires refreshing after conflicts and hides writes from readers", async () => {
    const allResults = { ...result, matches: [result.matches[0], { ...result.matches[0], column: 14, from: 33, to: 36 }, result.matches[1]] };
    vi.mocked(api).mockResolvedValue(allResults);
    await enter("key"); await advance(); await enterReplacement("new");
    await act(async () => document.querySelector<HTMLButtonElement>(".project-replace-all")!.click());
    expect(api).toHaveBeenCalledTimes(1);
    const dialogs = document.querySelectorAll<HTMLElement>('[role="dialog"]');
    expect(dialogs).toHaveLength(2);
    const buttons = dialogs[1].querySelectorAll<HTMLButtonElement>(".dialog-footer button");
    vi.mocked(api).mockRejectedValueOnce(new Error("Source changed"));
    await act(async () => buttons[1].click());
    expect(JSON.parse(vi.mocked(api).mock.calls[1][1]!.body as string).targets).toEqual([
      { path: "chapters/intro.tex", sourceHash: "a".repeat(64), ranges: [{ from: 26, to: 29 }, { from: 33, to: 36 }] },
      { path: "library.bib", sourceHash: "b".repeat(64), ranges: [{ from: 9, to: 12 }] }
    ]);
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    expect(document.querySelector('[role="alert"]')!.textContent).toContain("Source changed");
    expect(document.querySelector<HTMLButtonElement>(".project-replace-match")!.disabled).toBe(true);
    await act(async () => document.querySelector<HTMLButtonElement>(".project-search-error button")!.click()); await advance();
    expect(document.querySelector<HTMLButtonElement>(".project-replace-all")!.disabled).toBe(false);
    await act(async () => root.render(createElement(ProjectSearchDialog, { projectId: "project", onClose: close, onNavigate: navigate, readOnly: true })));
    expect(document.querySelector(".project-replace-input, .project-replace-match, .project-replace-all")).toBeNull();
    expect(document.querySelectorAll(".project-search-match")).toHaveLength(3);
  });

  it("retains results and collapsed groups during immediate revalidation, then uses the fresh file hash", async () => {
    const initial: ProjectSearchResult = { matches: [result.matches[0], { ...result.matches[0], line: 5, from: 46, to: 49 }, result.matches[1]], limited: false };
    let finishReplacement!: (value: unknown) => void, finishRefresh!: (value: unknown) => void;
    vi.mocked(api).mockResolvedValueOnce(initial)
      .mockReturnValueOnce(new Promise((resolve) => { finishReplacement = resolve; }))
      .mockReturnValueOnce(new Promise((resolve) => { finishRefresh = resolve; }));
    await enter("key"); await advance(); await enterReplacement("new-key");
    const list = document.querySelector<HTMLElement>(".project-search-results")!;
    const groups = [...list.querySelectorAll("details")];
    const remainingRow = list.querySelectorAll(".project-search-row")[1];
    groups[1].open = false; list.scrollTop = 120;
    await act(async () => list.querySelector<HTMLButtonElement>(".project-replace-match")!.click());
    await act(async () => finishReplacement({ replaced: 1, files: 1 }));
    expect(document.querySelectorAll(".project-search-row")).toHaveLength(3);
    expect(document.querySelector(".project-search-results")).toBe(list);
    expect(list.getAttribute("aria-busy")).toBe("true");
    expect(list.querySelector<HTMLButtonElement>(".project-replace-match")!.disabled).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(api).toHaveBeenCalledTimes(3); // Refresh does not wait for the typing debounce.
    const fresh = { ...initial.matches[1], from: 50, to: 53, sourceHash: "c".repeat(64) };
    await act(async () => finishRefresh({ matches: [fresh, result.matches[1]], limited: false }));
    expect([...list.querySelectorAll("details")]).toEqual(groups);
    expect(groups[1].open).toBe(false); expect(list.scrollTop).toBe(120);
    expect(list.querySelector(".project-search-row")).toBe(remainingRow);
    expect(list.getAttribute("aria-busy")).toBe("false");
    vi.mocked(api).mockResolvedValueOnce({ replaced: 1, files: 1 });
    await act(async () => list.querySelector<HTMLButtonElement>(".project-replace-match")!.click());
    expect(JSON.parse(vi.mocked(api).mock.calls[3][1]!.body as string).targets).toEqual([{ path: fresh.path, ranges: [{ from: 50, to: 53 }], sourceHash: fresh.sourceHash }]);
  });

  it("keeps results visible but blocks stale replacements if background refresh fails", async () => {
    vi.mocked(api).mockResolvedValueOnce(result).mockResolvedValueOnce({ replaced: 1, files: 1 })
      .mockRejectedValueOnce(new Error("Refresh unavailable"));
    await enter("key"); await advance(); await enterReplacement("new-key");
    const first = document.querySelector<HTMLButtonElement>(".project-replace-match")!;
    await act(async () => first.click());
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(document.querySelectorAll(".project-search-row")).toHaveLength(2);
    expect(document.querySelector('[role="alert"]')!.textContent).toContain("Refresh unavailable");
    expect(first.disabled).toBe(true);
    expect(document.querySelector<HTMLButtonElement>(".project-replace-all")!.disabled).toBe(true);
    vi.mocked(api).mockResolvedValueOnce({ matches: [], limited: false });
    await act(async () => document.querySelector<HTMLButtonElement>(".project-search-error button")!.click());
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(document.querySelectorAll(".project-search-row")).toHaveLength(0);
  });
});
