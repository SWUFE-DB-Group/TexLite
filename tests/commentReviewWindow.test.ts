// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Comment } from "../src/client/types";
import { useCommentReviewWindow } from "../src/client/workspace/useCommentReviewWindow";

let root: Root, host: HTMLDivElement;
let queue: Comment[], enabled: boolean, contextKey: string, pinnedIds: string[];
let windowed: ReturnType<typeof useCommentReviewWindow>;
function Harness() { windowed = useCommentReviewWindow(queue, enabled, contextKey, pinnedIds); return null; }
async function render() { await act(async () => root.render(createElement(Harness))); }

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  queue = Array.from({ length: 126 }, (_, index) => ({ id: `comment-${index + 1}` } as Comment));
  enabled = true; contextKey = "project:resolved:source"; pinnedIds = [];
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await render();
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

describe("resolved comment presentation window", () => {
  it("shows batches of 50 threads, not replies, and stops at the actual total", async () => {
    queue = [{ ...queue[0], replies: Array.from({ length: 120 }, () => ({})) } as Comment, ...queue.slice(1)];
    await render();
    expect(windowed.shown).toHaveLength(50);
    expect(windowed.shown[0].replies).toHaveLength(120);
    expect(windowed.hasMore).toBe(true);
    await act(async () => windowed.loadMore());
    expect(windowed.shown).toHaveLength(100);
    await act(async () => windowed.loadMore());
    expect(windowed.shown).toHaveLength(126);
    expect(windowed.hasMore).toBe(false);
  });

  it("leaves Open and single-thread views unlimited", async () => {
    enabled = false; await render();
    expect(windowed.shown).toBe(queue);
    expect(windowed.hasMore).toBe(false);
  });

  it("retains the window through new resource arrays, deletions and ordinary rerenders", async () => {
    await act(async () => windowed.loadMore());
    queue = queue.map((comment) => ({ ...comment })); await render();
    expect(windowed.shown).toHaveLength(100);
    const shown = windowed.shown;
    await render(); expect(windowed.shown).toBe(shown);
    queue = queue.slice(0, 75); await render();
    expect(windowed.shown).toHaveLength(75);
    expect(windowed.hasMore).toBe(false);
    queue = Array.from({ length: 126 }, (_, index) => ({ id: `new-${index}` } as Comment)); await render();
    expect(windowed.shown).toHaveLength(100);
  });

  it("resets for changed review criteria but not for Load more", async () => {
    await act(async () => { windowed.loadMore(); windowed.loadMore(); });
    expect(windowed.shown).toHaveLength(126);
    contextKey = "project:resolved:newest"; await render();
    expect(windowed.shown).toHaveLength(50);
    contextKey = "file:other.tex:resolved:newest"; await render();
    expect(windowed.shown).toHaveLength(50);
  });

  it("reveals a navigation target before commit and retains the expanded window after focus clears", async () => {
    pinnedIds = ["comment-51"]; await render();
    expect(windowed.shown).toHaveLength(100);
    pinnedIds = ["comment-120"]; await render();
    expect(windowed.shown).toHaveLength(126);
    pinnedIds = []; await render();
    expect(windowed.shown).toHaveLength(126);
  });

  it("keeps an active discussion visible when refreshed source order moves it beyond the prefix", async () => {
    pinnedIds = ["comment-10"]; await render();
    expect(windowed.shown).toHaveLength(50);
    queue = [...queue.filter(({ id }) => id !== "comment-10"), queue[9]]; await render();
    expect(windowed.shown.at(-1)?.id).toBe("comment-10");
    expect(windowed.shown).toHaveLength(126);
  });

  it("does not expand for a target absent from the filtered queue", async () => {
    pinnedIds = ["not-in-this-scope"]; await render();
    expect(windowed.shown).toHaveLength(50);
  });
});
