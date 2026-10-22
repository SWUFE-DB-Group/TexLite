// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FILE_DELETION_DURATION_MS, reconcileDeletionEntries, useDeletionTransitions } from "../src/client/useDeletionTransitions";

interface Item { id: string }
const keyOf = (item: Item) => item.id;
const item = (id: string) => ({ id });
const entries = (...ids: string[]) => ids.map((id) => ({ item: item(id), removeAt: null }));
const options = { deletedKey: "first", keyOf, duration: FILE_DELETION_DURATION_MS };

describe("confirmed deletion entries", () => {
  it("retains only the deleted item at its old position, not items hidden by unrelated changes", () => {
    const result = reconcileDeletionEntries(entries("first", "filtered", "next"), [item("next")], options, 100);
    expect(result).toEqual([
      { item: item("first"), removeAt: 100 + FILE_DELETION_DURATION_MS + 50 },
      { item: item("next"), removeAt: null }
    ]);
    expect(reconcileDeletionEntries(entries("first"), [], { ...options, deletedKey: null }, 100)).toEqual([]);
    expect(reconcileDeletionEntries(entries("first"), [item("first")], options, 100)).toEqual(entries("first"));
  });

  it("removes a folder and its visible descendants together without matching sibling prefixes", () => {
    const contains = (root: string, key: string) => key === root || key.startsWith(`${root}/`);
    const result = reconcileDeletionEntries(entries("data", "data/a.tex", "data/nested", "data/nested/b.txt", "database.tex"), [],
      { ...options, deletedKey: "data", contains }, 100);
    expect(result.map((entry) => entry.item.id)).toEqual(["data", "data/a.tex", "data/nested", "data/nested/b.txt"]);
    expect(new Set(result.map((entry) => entry.removeAt)).size).toBe(1);
  });

  it("preserves deadlines across refreshes and simultaneous deletions without reviving expired rows", () => {
    const first = reconcileDeletionEntries(entries("first", "second"), [item("second")], options, 100);
    const next = reconcileDeletionEntries(first, [], { ...options, deletedKey: "second" }, 150);
    expect(next.map((entry) => entry.removeAt)).toEqual([330, 380]);
    expect(reconcileDeletionEntries(next, [], options, 350).map((entry) => entry.item.id)).toEqual(["second"]);
    expect(reconcileDeletionEntries(next, [], options, 400)).toEqual([]);
  });

  it("lets a newly present item with the same key replace an exiting row", () => {
    const before = [{ item: item("first"), removeAt: 300 }];
    expect(reconcileDeletionEntries(before, [item("first")], options, 200)).toEqual(entries("first"));
  });
});

describe("deletion presentation lifecycle", () => {
  let host: HTMLDivElement;
  let root: Root;
  let unmounted: boolean;
  function List({ items, deletedKey = null, scopeKey = "project" }: { items: Item[]; deletedKey?: string | null; scopeKey?: string }) {
    const { entries: displayed, finishExit } = useDeletionTransitions(items, { ...options, deletedKey, scopeKey });
    return createElement("div", null, displayed.map(({ item, removeAt }) => createElement("div", {
      key: item.id, "data-id": item.id, "data-exiting": removeAt !== null,
      inert: removeAt !== null || undefined, "aria-hidden": removeAt !== null || undefined,
      onAnimationEnd: () => finishExit(item.id)
    }, item.id)));
  }
  const render = async (props: Parameters<typeof List>[0]) => act(async () => root.render(createElement(List, props)));
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    unmounted = false;
  });
  afterEach(async () => {
    if (!unmounted) await act(async () => root.unmount());
    host.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("retains an inert presentation row only until the original cleanup deadline", async () => {
    await render({ items: [item("first"), item("next")] });
    await render({ items: [item("next")], deletedKey: "first" });
    const exiting = host.querySelector<HTMLElement>('[data-id="first"]')!;
    expect(exiting.inert).toBe(true);
    expect(exiting.getAttribute("aria-hidden")).toBe("true");
    await act(async () => vi.advanceTimersByTime(100));
    await render({ items: [item("next")], deletedKey: "first" });
    await act(async () => vi.advanceTimersByTime(129));
    expect(host.querySelector('[data-id="first"]')).not.toBeNull();
    await act(async () => vi.advanceTimersByTime(1));
    expect(host.querySelector('[data-id="first"]')).toBeNull();
    await render({ items: [item("next")], deletedKey: "first" });
    expect(host.textContent).toBe("next");
  });

  it("clears transient rows when changing project, filters or pagination", async () => {
    await render({ items: [item("first")] });
    await render({ items: [], deletedKey: "first" });
    expect(host.textContent).toBe("first");
    await render({ items: [item("other")], scopeKey: "other-project" });
    expect(host.textContent).toBe("other");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("finishes on animation completion and cleans up its timer when unmounted", async () => {
    await render({ items: [item("first")] });
    await render({ items: [], deletedKey: "first" });
    await act(async () => host.querySelector('[data-id="first"]')!.dispatchEvent(new Event("animationend", { bubbles: true })));
    expect(host.textContent).toBe("");
    expect(vi.getTimerCount()).toBe(0);
    await render({ items: [item("first")] });
    await render({ items: [], deletedKey: "first" });
    await act(async () => root.unmount());
    unmounted = true;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("skips exit rows entirely when reduced motion is enabled", async () => {
    vi.spyOn(window, "matchMedia").mockReturnValue({ matches: true } as MediaQueryList);
    await render({ items: [item("first")] });
    await render({ items: [], deletedKey: "first" });
    expect(host.textContent).toBe("");
    expect(vi.getTimerCount()).toBe(0);
  });
});
