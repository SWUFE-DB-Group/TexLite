// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COMMENT_SHRED_DURATION_MS, prepareCommentDeletionEffect } from "../src/client/workspace/commentDeletionEffect";

let owner: HTMLDivElement;
let comment: HTMLElement;
beforeEach(() => {
  vi.useFakeTimers();
  owner = document.createElement("div");
  owner.className = "comments";
  comment = document.createElement("article");
  comment.textContent = "Private comment text";
  owner.append(comment);
  document.body.append(owner);
  vi.spyOn(comment, "getBoundingClientRect").mockReturnValue(new DOMRect(100, 100, 240, 140));
});
afterEach(() => {
  owner.remove();
  document.querySelectorAll(".comment-paper-shred").forEach((element) => element.dispatchEvent(new Event("animationend")));
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("comment deletion paper effect", () => {
  it("captures geometry without displaying anything until success, even after React removes the source", () => {
    const play = prepareCommentDeletionEffect(comment);
    expect(document.querySelector(".comment-paper-shred")).toBeNull();
    comment.remove();
    play();
    const layer = document.querySelector<HTMLElement>(".comment-paper-shred")!;
    expect(layer.children).toHaveLength(22);
    expect(layer.textContent).toBe("");
    expect(layer.getAttribute("aria-hidden")).toBe("true");
    expect(layer.inert).toBe(true);
    expect(layer.style.left).toBe("100px");
    expect(layer.style.width).toBe("240px");
    expect(layer.style.getPropertyValue("--shred-duration")).toBe(`${COMMENT_SHRED_DURATION_MS}ms`);
    for (const piece of layer.querySelectorAll<HTMLElement>("span")) {
      expect(Number.parseFloat(piece.style.animationDuration) + Number.parseFloat(piece.style.animationDelay)).toBeLessThan(COMMENT_SHRED_DURATION_MS);
      expect(piece.style.getPropertyValue("--shred-flip")).toMatch(/deg$/);
    }
    vi.advanceTimersByTime(650);
    expect(layer.isConnected).toBe(true);
    vi.advanceTimersByTime(COMMENT_SHRED_DURATION_MS + 200 - 650);
    expect(document.querySelector(".comment-paper-shred")).toBeNull();
  });

  it("cleans up on animation completion without waiting for the fallback", () => {
    prepareCommentDeletionEffect(comment)();
    document.querySelector(".comment-paper-shred")!.dispatchEvent(new Event("animationend"));
    expect(document.querySelector(".comment-paper-shred")).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not end the effect when a cut, fold or individual strip finishes", () => {
    prepareCommentDeletionEffect(comment)();
    const layer = document.querySelector<HTMLElement>(".comment-paper-shred")!;
    const cut = new Event("animationend", { bubbles: true });
    Object.defineProperty(cut, "pseudoElement", { value: "::after" });
    layer.dispatchEvent(cut);
    layer.firstElementChild!.dispatchEvent(new Event("animationend", { bubbles: true }));
    expect(layer.isConnected).toBe(true);
  });

  it("uses fewer strips for a short reply and never plays a prepared effect twice", () => {
    vi.mocked(comment.getBoundingClientRect).mockReturnValue(new DOMRect(100, 100, 190, 70));
    const play = prepareCommentDeletionEffect(comment);
    play(); play();
    const layers = document.querySelectorAll(".comment-paper-shred");
    expect(layers).toHaveLength(1);
    expect(layers[0].children).toHaveLength(9);
  });

  it("bounds particle work for a large source and clips the captured paper to its panel", () => {
    owner.className = "context-panel comments";
    vi.spyOn(owner, "getBoundingClientRect").mockReturnValue(new DOMRect(100, 100, 600, 220));
    vi.mocked(comment.getBoundingClientRect).mockReturnValue(new DOMRect(80, 80, 2000, 2000));
    prepareCommentDeletionEffect(comment)();
    const layer = document.querySelector<HTMLElement>(".comment-paper-shred")!;
    expect(layer.children).toHaveLength(24);
    expect(layer.style.left).toBe("100px");
    expect(layer.style.top).toBe("100px");
    expect(layer.style.width).toBe("600px");
    expect(layer.style.height).toBe("180px");
  });

  it("cleans up if the viewport resizes or the discussion is unmounted mid-animation", async () => {
    prepareCommentDeletionEffect(comment)();
    window.dispatchEvent(new Event("resize"));
    expect(document.querySelector(".comment-paper-shred")).toBeNull();
    prepareCommentDeletionEffect(comment)();
    owner.remove();
    await vi.advanceTimersByTimeAsync(0);
    expect(document.querySelector(".comment-paper-shred")).toBeNull();
  });

  it("respects reduced motion, including a preference changed during the delete request", () => {
    const play = prepareCommentDeletionEffect(comment);
    vi.spyOn(window, "matchMedia").mockReturnValue({ matches: true } as MediaQueryList);
    play();
    prepareCommentDeletionEffect(comment)();
    expect(document.querySelector(".comment-paper-shred")).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not animate after leaving the workspace or for offscreen content", () => {
    const play = prepareCommentDeletionEffect(comment);
    owner.remove();
    play();
    document.body.append(owner);
    vi.mocked(comment.getBoundingClientRect).mockReturnValue(new DOMRect(100, -200, 240, 100));
    prepareCommentDeletionEffect(comment)();
    expect(document.querySelector(".comment-paper-shred")).toBeNull();
  });
});
