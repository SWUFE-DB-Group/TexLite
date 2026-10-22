// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prepareCommentDeletionEffect } from "../src/client/workspace/commentDeletionEffect";

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
  document.querySelectorAll(".comment-paper-shred").forEach((element) => element.remove());
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
    expect(layer.children).toHaveLength(24);
    expect(layer.textContent).toBe("");
    expect(layer.getAttribute("aria-hidden")).toBe("true");
    expect(layer.inert).toBe(true);
    expect(layer.style.left).toBe("100px");
    expect(layer.style.width).toBe("240px");
    vi.advanceTimersByTime(650);
    expect(document.querySelector(".comment-paper-shred")).toBeNull();
  });

  it("cleans up on animation completion without waiting for the fallback", () => {
    prepareCommentDeletionEffect(comment)();
    document.querySelector(".comment-paper-shred")!.dispatchEvent(new Event("animationend"));
    expect(document.querySelector(".comment-paper-shred")).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
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
