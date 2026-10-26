import { describe, expect, it, vi } from "vitest";
import { CommentDraftStore, type CommentDraftKey } from "../src/client/workspace/commentDrafts";

describe("workspace comment drafts", () => {
  it("isolates threads and form types, preserving each reply edit when switching editors", () => {
    const store = new CommentDraftStore();
    store.open("first", "reply", "Reply draft");
    store.open("first", "edit-comment", "Comment draft");
    store.open("first", "edit-reply:a", "First reply edit");
    store.open("first", "edit-reply:b", "Second reply edit");
    store.open("second", "reply", "Other thread");
    expect(store.getThread("first")["edit-reply:a"]).toMatchObject({ open: false, content: "First reply edit" });
    store.open("first", "edit-reply:a", "Server text should not replace the draft");
    expect(store.getThread("first")["edit-reply:a"]).toMatchObject({ open: true, content: "First reply edit" });
    expect(store.getThread("first")["edit-reply:b"]?.open).toBe(false);
    expect(store.getThread("first").reply?.content).toBe("Reply draft");
    expect(store.getThread("first")["edit-comment"]?.content).toBe("Comment draft");
    expect(store.getThread("second").reply?.content).toBe("Other thread");
  });

  it("retains intentional empty edits and clears only explicitly discarded drafts", () => {
    const store = new CommentDraftStore();
    store.open("thread", "edit-comment", "Original");
    store.change("thread", "edit-comment", "");
    store.open("thread", "edit-comment", "New server content");
    expect(store.getThread("thread")["edit-comment"]?.content).toBe("");
    store.open("thread", "reply", "Keep this");
    store.discard("thread", "edit-comment");
    expect(store.getThread("thread")["edit-comment"]).toBeUndefined();
    expect(store.getThread("thread").reply?.content).toBe("Keep this");
    store.discard("thread");
    expect(store.getThread("thread")).toEqual({});
  });

  it("only notifies subscribers of the changed thread and keeps snapshot identities stable", () => {
    const store = new CommentDraftStore();
    const first = vi.fn(); const second = vi.fn();
    const unsubscribe = store.subscribe("first", first);
    store.subscribe("second", second);
    const empty = store.getThread("first");
    expect(store.getThread("first")).toBe(empty);
    store.open("first", "reply", "Text");
    const snapshot = store.getThread("first");
    expect(snapshot).not.toBe(empty);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
    store.open("second", "reply");
    expect(store.getThread("first")).toBe(snapshot);
    unsubscribe();
    store.change("first", "reply", "Changed");
    expect(first).toHaveBeenCalledTimes(1);
  });

  it.each<CommentDraftKey>(["reply", "edit-comment", "edit-reply:a"])("keeps %s request state until completion and prevents repeated submits", async (key) => {
    const store = new CommentDraftStore();
    store.open("thread", key, "Draft text");
    let finish!: (value: boolean) => void;
    const action = vi.fn(() => new Promise<boolean>((resolve) => { finish = resolve; }));
    const first = store.submit("thread", key, action, "Failed");
    expect(store.getThread("thread")[key]).toMatchObject({ pending: true, content: "Draft text" });
    const pendingSnapshot = store.getThread("thread");
    expect(await store.submit("thread", key, action, "Failed")).toBe(false);
    store.change("thread", key, "Cannot overwrite pending input");
    store.open("thread", "reply", "Another action");
    expect(store.getThread("thread")).toBe(pendingSnapshot);
    expect(action).toHaveBeenCalledExactlyOnceWith("Draft text");
    finish(true);
    expect(await first).toBe(true);
    expect(store.getThread("thread")[key]).toBeUndefined();
  });

  it("blocks conflicting operations in the same thread but not a different thread", async () => {
    const store = new CommentDraftStore();
    store.open("first", "reply", "Reply");
    store.open("first", "edit-comment", "Edit");
    store.open("second", "reply", "Other");
    let finish!: (value: boolean) => void;
    const first = store.submit("first", "reply", () => new Promise((resolve) => { finish = resolve; }), "Failed");
    const conflict = vi.fn(async () => true);
    expect(await store.submit("first", "edit-comment", conflict, "Failed")).toBe(false);
    expect(conflict).not.toHaveBeenCalled();
    expect(await store.submit("second", "reply", async () => true, "Failed")).toBe(true);
    finish(true); await first;
    expect(store.getThread("first")["edit-comment"]?.content).toBe("Edit");
  });

  it.each([false, "throw"])("retains errors and text after failure (%s), then clears only on successful retry", async (failure) => {
    const store = new CommentDraftStore();
    store.open("thread", "reply", "Keep this text");
    expect(await store.submit("thread", "reply", async () => {
      if (failure === "throw") throw new Error("Network unavailable");
      return false;
    }, "Please retry")).toBe(false);
    expect(store.getThread("thread").reply).toMatchObject({ content: "Keep this text", pending: false, open: true,
      error: failure === "throw" ? "Network unavailable" : "Please retry" });
    expect(await store.submit("thread", "reply", async () => true, "Failed")).toBe(true);
    expect(store.getThread("thread").reply).toBeUndefined();
  });

  it.each([true, false])("does not recreate or clear a replacement draft when an old request finishes (%s)", async (success) => {
    const store = new CommentDraftStore();
    store.open("thread", "reply", "Old text");
    let finish!: (value: boolean) => void;
    const pending = store.submit("thread", "reply", () => new Promise((resolve) => { finish = resolve; }), "Failed");
    store.discard("thread");
    store.open("thread", "reply", "New draft");
    finish(success); await pending;
    expect(store.getThread("thread").reply).toMatchObject({ content: "New draft", pending: false, error: "" });
  });

  it("does not submit blank or missing drafts", async () => {
    const store = new CommentDraftStore();
    const action = vi.fn(async () => true);
    expect(await store.submit("thread", "reply", action, "Failed")).toBe(false);
    store.open("thread", "reply", " \n ");
    expect(await store.submit("thread", "reply", action, "Failed")).toBe(false);
    expect(action).not.toHaveBeenCalled();
  });

  it("keeps new-comment text with its original file, selection and source hash", () => {
    const store = new CommentDraftStore();
    const selection = { selectedText: "Original source", startOffset: 10, endOffset: 25 };
    store.setNew({ filePath: "main.tex", selection, sourceHash: "original-hash", content: "Main draft" });
    selection.startOffset = 100;
    store.setNew({ filePath: "chapter.tex", selection, sourceHash: "chapter-hash", content: "Chapter draft" });
    expect(store.getNew("main.tex")).toMatchObject({ content: "Main draft", sourceHash: "original-hash", selection: { startOffset: 10 } });
    expect(store.getNew("chapter.tex")?.content).toBe("Chapter draft");
    store.discardNew("main.tex");
    expect(store.getNew("main.tex")).toBeUndefined();
    expect(store.getNew("chapter.tex")?.content).toBe("Chapter draft");
  });

  it("never shares drafts with a different workspace instance", () => {
    const first = new CommentDraftStore();
    first.open("thread", "reply", "Private draft");
    first.setNew({ filePath: "main.tex", selection: { selectedText: "", startOffset: 0, endOffset: 0 }, sourceHash: "hash", content: "New draft" });
    const other = new CommentDraftStore();
    expect(other.getThread("thread")).toEqual({});
    expect(other.getNew("main.tex")).toBeUndefined();
  });
});
