import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/server/app.js";
import { loadConfig, type Config } from "../src/server/config.js";
import { openDatabase, type DatabaseConnection } from "../src/server/db.js";
import { createSessionToken } from "../src/server/security.js";
import { resolveSourcePath } from "../src/server/files.js";
import type { Comment } from "../src/shared/comments.js";
import { CollaborationService, collaborationStatePath } from "../src/server/collaboration.js";

let root: string, config: Config, db: DatabaseConnection, app: FastifyInstance, projectId: string;
const cookies = new Map<string, string>();
const initial = "Before.\nThe results prove the hypothesis.\nAfter.\n";
const hash = (source: string) => createHash("sha256").update(source, "utf8").digest("hex");
const source = () => fs.readFileSync(resolveSourcePath(config, projectId, "main.tex"), "utf8");
function request(user: string, method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", url: string, payload?: unknown) {
  return app.inject({ method, url: url.replaceAll(":project", projectId), headers: { cookie: cookies.get(user)!, "accept-language": "zh" }, payload: payload as object });
}
async function comments(): Promise<Comment[]> { return (await request("owner", "GET", "/api/projects/:project/comments?path=main.tex")).json().comments; }
async function suggest(reviewerId = "owner", replacementText = "suggest", author = "reader", original = "prove") {
  const text = source(), startOffset = text.indexOf(original);
  const result = await request(author, "POST", "/api/projects/:project/comments", {
    path: "main.tex", content: "", startOffset, endOffset: startOffset + original.length, sourceHash: hash(text),
    suggestion: { reviewerId, replacementText }
  });
  expect(result.statusCode, result.body).toBe(201);
  return result.json().comment as Comment;
}
const review = (comment: Comment, action = "accept", user = "owner") => request(user, "POST", `/api/projects/:project/comments/${comment.id}/suggestion/review`, { action, expectedReplacementText: comment.suggestion!.replacementText });
const revise = (comment: Comment, replacementText: string, user = "reader") => request(user, "PATCH", `/api/projects/:project/comments/${comment.id}/suggestion`, {
  replacementText, expectedReplacementText: comment.suggestion!.replacementText
});

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "texlite-suggestions-"));
  const file = path.join(root, "config.json");
  fs.writeFileSync(file, JSON.stringify({ storage: { dataDir: path.join(root, "data") }, updates: { enabled: false } }));
  config = loadConfig(file); db = openDatabase(config); cookies.clear();
  for (const id of ["owner", "writer", "reader", "other"]) {
    db.prepare("INSERT INTO users (id, username, display_name, password_hash, role, can_create_projects, created_at) VALUES (?, ?, ?, 'hash', ?, 1, ?)")
      .run(id, id, id.toUpperCase(), id === "owner" ? "admin" : "user", new Date().toISOString());
    const session = createSessionToken();
    db.prepare("INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)").run(session.digest, id, "2099-01-01", "2026-11-01");
    cookies.set(id, `texlite_session=${session.token}`);
  }
  app = await buildApp(config, db, { logger: false }); await app.ready();
  const created = await request("owner", "POST", "/api/projects", { name: "Suggestion test" });
  expect(created.statusCode, created.body).toBe(201); projectId = created.json().project.id;
  for (const [id, permission] of [["writer", "edit"], ["reader", "read"], ["other", "edit"]]) {
    db.prepare("INSERT INTO project_members (project_id, user_id, permission, created_at) VALUES (?, ?, ?, ?)").run(projectId, id, permission, "2026-11-01");
  }
  expect((await request("owner", "PUT", "/api/projects/:project/file", { path: "main.tex", content: initial })).statusCode).toBe(200);
});
afterEach(async () => { vi.restoreAllMocks(); await app?.close(); db?.close(); fs.rmSync(root, { recursive: true, force: true }); });

describe("comment suggestion workflow", () => {
  it.each(["deleted", "disabled", "removed", "read-only"])("lets another project writer resolve a pending suggestion when its reviewer is %s", async reason => {
    const comment = await suggest("writer");
    const endpoint = `/api/projects/:project/comments/${comment.id}`;
    const blocked = await request("other", "PATCH", endpoint, { resolved: true });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().code).toBe("SUGGESTION_PENDING");
    if (reason === "deleted") db.prepare("DELETE FROM users WHERE id = 'writer'").run();
    if (reason === "disabled") db.prepare("UPDATE users SET disabled = 1 WHERE id = 'writer'").run();
    if (reason === "removed") db.prepare("DELETE FROM project_members WHERE user_id = 'writer'").run();
    if (reason === "read-only") db.prepare("UPDATE project_members SET permission = 'read' WHERE user_id = 'writer'").run();
    expect((await comments())[0].suggestion?.reviewerAvailable).toBe(false);
    expect((await request("reader", "PATCH", endpoint, { resolved: true })).statusCode).toBe(403);
    const resolved = await request("other", "PATCH", endpoint, { resolved: true });
    expect(resolved.statusCode, resolved.body).toBe(200);
    expect((await comments())[0]).toMatchObject({ resolved: true, resolvedById: "other", suggestion: { status: "pending" } });
    expect(source()).toBe(initial);
    expect((await request("owner", "PATCH", endpoint, { resolved: false })).statusCode).toBe(200);
    expect((await comments())[0].resolved).toBe(false);
    db.prepare("DELETE FROM project_members WHERE user_id = 'other'").run();
    expect((await request("other", "PATCH", endpoint, { resolved: true })).statusCode).toBe(404);
  });

  it("does not let a missing reviewer bypass an in-flight source application", async () => {
    const comment = await suggest("writer");
    db.prepare("DELETE FROM users WHERE id = 'writer'").run();
    db.prepare("UPDATE comment_suggestions SET apply_update = ? WHERE comment_id = ?").run(Buffer.from([0, 0]), comment.id);
    const result = await request("other", "PATCH", `/api/projects/:project/comments/${comment.id}`, { resolved: true });
    expect(result.statusCode).toBe(409);
    expect(result.json().code).toBe("SUGGESTION_PENDING");
    db.prepare("UPDATE comment_suggestions SET apply_update = NULL WHERE comment_id = ?").run(comment.id);
  });

  it("keeps ordinary comments free of reviewer metadata and review notifications", async () => {
    const response = await request("reader", "POST", "/api/projects/:project/comments", {
      path: "main.tex", content: "@owner please check this claim.", startOffset: 0, endOffset: 6, sourceHash: hash(initial)
    });
    expect(response.statusCode, response.body).toBe(201);
    const comment = response.json().comment as Comment;
    expect(comment.suggestion).toBeNull();
    expect(comment).not.toHaveProperty("reviewer");
    expect(db.prepare("SELECT COUNT(*) AS count FROM comment_suggestions").get()).toEqual({ count: 0 });
    const notifications = (await request("owner", "GET", "/api/projects/:project/mentions?unread=1")).json().mentions;
    expect(notifications).toHaveLength(1);
    expect(notifications).toMatchObject([{ kind: "mention", commentId: comment.id }]);
  });

  it("excludes the author from reviewer candidates and refuses self-assignment, including for project owners", async () => {
    const start = initial.indexOf("prove");
    for (const author of ["owner", "writer"]) {
      const people = (await request(author, "GET", "/api/projects/:project/suggestion-reviewers")).json().users as Array<{ id: string }>;
      expect(people.map((user) => user.id)).not.toContain(author);
      const result = await request(author, "POST", "/api/projects/:project/comments", {
        path: "main.tex", startOffset: start, endOffset: start + 5, sourceHash: hash(initial),
        suggestion: { reviewerId: author, replacementText: "suggest" }
      });
      expect(result.statusCode, result.body).toBe(400);
      expect(result.json().code).toBe("SUGGESTION_SELF_REVIEW");
    }
    expect(await comments()).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) AS count FROM comment_mentions").get()).toEqual({ count: 0 });
    const comment = await suggest("writer", "suggest", "owner");
    const reassigned = await request("owner", "PATCH", `/api/projects/:project/comments/${comment.id}/suggestion`, { reviewerId: "owner" });
    expect(reassigned.statusCode).toBe(400);
    expect(reassigned.json().code).toBe("REQUEST_INVALID");
    expect((await review(comment, "accept", "writer")).statusCode).toBe(200);
  });

  it("also prevents an existing comment's writable author from attaching a self-reviewed suggestion", async () => {
    const start = initial.indexOf("prove");
    const created = await request("writer", "POST", "/api/projects/:project/comments", {
      path: "main.tex", content: "Please review", startOffset: start, endOffset: start + 5, sourceHash: hash(initial)
    });
    const id = created.json().comment.id;
    const endpoint = `/api/projects/:project/comments/${id}/suggestion`;
    const candidates = (await request("owner", "GET", `/api/projects/:project/suggestion-reviewers?commentId=${id}`)).json().users as Array<{ id: string }>;
    expect(candidates.map((user) => user.id).sort()).toEqual(["other", "owner"]);
    const result = await request("writer", "POST", endpoint, { replacementText: "suggest", reviewerId: "writer", sourceHash: hash(initial) });
    expect(result.statusCode).toBe(400); expect(result.json().code).toBe("SUGGESTION_SELF_REVIEW");
    expect((await comments())[0].suggestion).toBeNull();
    expect((await request("writer", "POST", endpoint, { replacementText: "suggest", reviewerId: "owner", sourceHash: hash(initial) })).statusCode).toBe(200);
  });

  it("blocks decisions on invalid self-assigned suggestions without exposing reassignment", async () => {
    const comment = await suggest("owner", "suggest", "writer");
    // An existing pending record must not bypass the new rule.
    db.prepare("UPDATE comment_suggestions SET reviewer_id = 'writer' WHERE comment_id = ?").run(comment.id);
    expect((await comments())[0].suggestion?.reviewerAvailable).toBe(false);
    for (const action of ["accept", "reject"]) {
      const result = await review(comment, action, "writer");
      expect(result.statusCode).toBe(403); expect(result.json().code).toBe("SUGGESTION_SELF_REVIEW");
    }
    const endpoint = `/api/projects/:project/comments/${comment.id}/suggestion`;
    expect((await request("owner", "PATCH", endpoint, { reviewerId: "writer" })).statusCode).toBe(400);
    expect((await request("owner", "PATCH", endpoint, { reviewerId: "owner" })).statusCode).toBe(400);
    expect(source()).toBe(initial);
  });

  it("keeps source unchanged, adds the default comment and sends a distinct review request only to writers", async () => {
    const people = (await request("reader", "GET", "/api/projects/:project/suggestion-reviewers")).json();
    expect(people.ownerId).toBe("owner");
    expect(people.users.map((user: { id: string }) => user.id).sort()).toEqual(["other", "owner", "writer"]);
    const comment = await suggest();
    expect(comment.content).toBe("修改意见"); expect(source()).toBe(initial);
    expect(comment.suggestion).toMatchObject({ status: "pending", originalText: "prove", replacementText: "suggest", reviewerId: "owner", applicable: true });
    const mentions = (await request("owner", "GET", "/api/projects/:project/mentions?unread=1")).json().mentions;
    expect(mentions).toHaveLength(1); expect(mentions[0]).toMatchObject({ kind: "review", commentId: comment.id });
    await request("owner", "POST", `/api/projects/:project/mentions/${mentions[0].id}/read`);
    expect((await comments())[0].suggestion?.status).toBe("pending");
    expect((await request("other", "PATCH", `/api/projects/:project/comments/${comment.id}`, { resolved: true })).statusCode).toBe(409);
    expect((await review(comment, "accept", "reader")).statusCode).toBe(403);
    expect((await review(comment, "accept", "writer")).statusCode).toBe(403);
  });

  it("deduplicates explicit @ and review notifications without parsing replacement source for mentions", async () => {
    const response = await request("reader", "POST", "/api/projects/:project/comments", { path: "main.tex", content: "@owner please review",
      startOffset: initial.indexOf("prove"), endOffset: initial.indexOf("prove") + 5, sourceHash: hash(initial), suggestion: { reviewerId: "owner", replacementText: "@writer" } });
    expect(response.statusCode).toBe(201);
    const mentions = (await request("owner", "GET", "/api/projects/:project/mentions?unread=1")).json().mentions;
    expect(mentions).toHaveLength(1); expect(mentions[0].kind).toBe("review");
    expect((await request("writer", "GET", "/api/projects/:project/mentions?unread=1")).json().mentions).toEqual([]);
  });

  it("keeps pending review mentions distinct but turns later explicit mentions into ordinary notifications", async () => {
    const comment = await suggest();
    const endpoint = `/api/projects/:project/comments/${comment.id}`;
    const unread = async () => (await request("owner", "GET", "/api/projects/:project/mentions?unread=1")).json().mentions;
    expect((await request("reader", "PATCH", endpoint, { content: "@owner take a look" })).statusCode).toBe(200);
    expect(await unread()).toMatchObject([{ kind: "review" }]);
    expect((await review(comment, "reject")).statusCode).toBe(200);
    expect(await unread()).toEqual([]);
    await request("reader", "PATCH", endpoint, { content: "Another question" });
    await request("reader", "PATCH", endpoint, { content: "@owner another question" });
    expect(await unread()).toMatchObject([{ kind: "mention" }]);
  });

  it("accepts exactly once, preserves the surrounding source, history attribution and discussion", async () => {
    const comment = await suggest("writer");
    const results = await Promise.all([review(comment, "accept", "writer"), review(comment, "accept", "writer")]);
    expect(results.map((result) => result.statusCode)).toEqual([200, 200]);
    expect(source()).toBe(initial.replace("prove", "suggest"));
    const updated = (await comments())[0];
    expect(updated).toMatchObject({ resolved: false, selectedText: "suggest", orphaned: false, suggestion: { status: "accepted", originalText: "prove", decidedById: "writer" } });
    expect(updated.suggestion?.decidedAt).toBeTruthy();
    const edits = db.prepare("SELECT author_id FROM project_edit_segments WHERE project_id = ?").all(projectId);
    expect(edits).toEqual([{ author_id: "writer" }]);
    expect((await request("writer", "GET", "/api/projects/:project/mentions?unread=1")).json().mentions).toEqual([]);
    expect((await review(comment, "reject", "writer")).statusCode).toBe(409);
    expect((await request("other", "PATCH", `/api/projects/:project/comments/${comment.id}`, { resolved: true })).statusCode).toBe(200);
    expect((await request("reader", "DELETE", `/api/projects/:project/comments/${comment.id}`)).statusCode).toBe(200);
    expect(source()).toBe(initial.replace("prove", "suggest"));
  });

  it("supports deletion suggestions and keeps a point anchor on the discussion", async () => {
    const comment = await suggest("owner", "");
    expect((await review(comment)).statusCode).toBe(200);
    expect(source()).toBe(initial.replace("prove", ""));
    expect((await comments())[0]).toMatchObject({ resolved: false, selectedText: "", orphaned: false, suggestion: { status: "accepted" } });
  });

  it("follows changes outside the passage but refuses changed or deleted source", async () => {
    const comment = await suggest();
    const prefix = "Another paragraph.\n";
    await request("owner", "PUT", "/api/projects/:project/file", { path: "main.tex", content: prefix + initial });
    expect((await review(comment)).statusCode).toBe(200);
    expect(source()).toBe(prefix + initial.replace("prove", "suggest"));
    const next = await suggest("owner", "indicate", "reader", "suggest");
    await request("owner", "PUT", "/api/projects/:project/file", { path: "main.tex", content: source().replace("suggest", "sugXXXgest") });
    const changed = source();
    const rejected = await review(next);
    expect(rejected.statusCode, rejected.body).toBe(409); expect(rejected.json().code).toBe("SUGGESTION_SOURCE_CHANGED");
    expect(source()).toBe(changed); expect((await comments())[1].suggestion?.status).toBe("pending");
    expect((await review(next, "reject")).statusCode).toBe(200); expect(source()).toBe(changed);
    expect((await comments())[1].resolved).toBe(false);
  });

  it("rechecks current write access and does not let the owner or another user reassign", async () => {
    const comment = await suggest("writer");
    db.prepare("UPDATE project_members SET permission = 'read' WHERE project_id = ? AND user_id = 'writer'").run(projectId);
    expect((await comments())[0].suggestion?.reviewerAvailable).toBe(false);
    expect((await review(comment, "accept", "writer")).statusCode).toBe(403);
    expect((await review(comment)).statusCode).toBe(403);
    const endpoint = `/api/projects/:project/comments/${comment.id}/suggestion`;
    expect((await request("other", "PATCH", endpoint, { reviewerId: "other" })).statusCode).toBe(400);
    expect((await request("owner", "PATCH", endpoint, { reviewerId: "reader" })).statusCode).toBe(400);
    expect((await request("owner", "PATCH", endpoint, { reviewerId: "owner" })).statusCode).toBe(400);
    expect((await comments())[0].suggestion?.reviewerId).toBe("writer");
  });

  it("lets a read-only author revise pending text and renews only the review request, without changing the source or reviewer", async () => {
    const comment = await suggest();
    const reply = await request("writer", "POST", `/api/projects/:project/comments/${comment.id}/replies`, { content: "Please use indicate." });
    expect(reply.statusCode).toBe(201);
    const unread = async () => (await request("owner", "GET", "/api/projects/:project/mentions?unread=1")).json().mentions;
    const notice = (await unread())[0];
    await request("owner", "POST", `/api/projects/:project/mentions/${notice.id}/read`);
    expect(await unread()).toEqual([]);
    const edited = await revise(comment, "indicate @writer");
    expect(edited.statusCode, edited.body).toBe(200);
    expect(edited.json().change.suggestion).toMatchObject({ originalText: "prove", replacementText: "indicate @writer", reviewerId: "owner", status: "pending" });
    expect(source()).toBe(initial);
    expect((await comments())[0]).toMatchObject({ content: "修改意见", replies: [{ content: "Please use indicate." }], suggestion: { replacementText: "indicate @writer" } });
    expect(await unread()).toMatchObject([{ id: notice.id, kind: "review", readAt: null }]);
    expect(await unread()).toHaveLength(1);
    expect((await request("writer", "GET", "/api/projects/:project/mentions?unread=1")).json().mentions).toEqual([]);
    // Lost-response retries acknowledge the save, without re-notifying a review already read.
    await request("owner", "POST", `/api/projects/:project/mentions/${notice.id}/read`);
    expect((await revise(comment, "indicate @writer")).statusCode).toBe(200);
    expect(await unread()).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) AS count FROM project_edit_segments WHERE project_id = ?").get(projectId)).toEqual({ count: 0 });
  });

  it("limits edits to the accessible author and validates replacements without changing the bound original or reviewer", async () => {
    const comment = await suggest();
    for (const user of ["owner", "writer", "other"]) expect((await revise(comment, "indicate", user)).statusCode).toBe(403);
    for (const value of ["prove", "x".repeat(50_001), "bad\0text", null]) {
      const invalid = await request("reader", "PATCH", `/api/projects/:project/comments/${comment.id}/suggestion`, { replacementText: value, expectedReplacementText: "suggest" });
      expect(invalid.statusCode, invalid.body).toBe(400);
    }
    const withAssignment = await request("reader", "PATCH", `/api/projects/:project/comments/${comment.id}/suggestion`, {
      replacementText: "indicate", expectedReplacementText: "suggest", reviewerId: "writer"
    });
    expect(withAssignment.statusCode).toBe(400);
    expect((await comments())[0].suggestion).toMatchObject({ originalText: "prove", replacementText: "suggest", reviewerId: "owner" });
    db.prepare("DELETE FROM project_members WHERE project_id = ? AND user_id = 'reader'").run(projectId);
    expect((await revise(comment, "indicate")).statusCode).toBe(404);
    expect(source()).toBe(initial);
  });

  it("rejects stale author saves and keeps an empty replacement as a valid deletion suggestion", async () => {
    const original = await suggest();
    expect((await revise(original, "indicate")).statusCode).toBe(200);
    const stale = await revise(original, "demonstrate");
    expect(stale.statusCode).toBe(409); expect(stale.json().code).toBe("SUGGESTION_UPDATED");
    const current = (await comments())[0];
    expect(current.suggestion?.replacementText).toBe("indicate");
    expect((await revise(current, "")).statusCode).toBe(200);
    const deletion = (await comments())[0];
    expect(deletion.suggestion?.replacementText).toBe("");
    expect((await review(deletion)).statusCode).toBe(200);
    expect(source()).toBe(initial.replace("prove", ""));
  });

  it.each(["accept", "reject"])("requires a reviewer to read the latest replacement before %s", async (action) => {
    const old = await suggest();
    expect((await revise(old, "indicate")).statusCode).toBe(200);
    const stale = await review(old, action);
    expect(stale.statusCode).toBe(409); expect(stale.json().code).toBe("SUGGESTION_UPDATED");
    expect(source()).toBe(initial);
    expect((await comments())[0].suggestion?.status).toBe("pending");
    const missingVersion = await request("owner", "POST", `/api/projects/:project/comments/${old.id}/suggestion/review`, { action });
    expect(missingVersion.statusCode).toBe(409);
    const current = (await comments())[0];
    expect((await review(current, action)).statusCode).toBe(200);
    const final = source();
    const lateEdit = await revise(current, "demonstrate");
    expect(lateEdit.statusCode).toBe(409); expect(lateEdit.json().code).toBe("SUGGESTION_DECIDED");
    expect(source()).toBe(final);
  });

  it("rechecks the reviewer snapshot after an author edits while the acceptance room is initializing", async () => {
    const comment = await suggest();
    const prepare = CollaborationService.prototype.prepareSourceEditRoom;
    let entered!: () => void, release!: () => void;
    const preparing = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(CollaborationService.prototype, "prepareSourceEditRoom").mockImplementationOnce(async function (this: CollaborationService, id) {
      entered(); await gate; await prepare.call(this, id);
    });
    const accepting = review(comment).then((response) => response);
    try {
      await preparing;
      expect((await revise(comment, "indicate")).statusCode).toBe(200);
    } finally { release(); }
    const result = await accepting;
    expect(result.statusCode).toBe(409); expect(result.json().code).toBe("SUGGESTION_UPDATED");
    expect(source()).toBe(initial);
    expect((await comments())[0].suggestion).toMatchObject({ status: "pending", replacementText: "indicate" });
  });

  it("can apply again after exact source and anchor recovery, but not after complete deletion", async () => {
    const comment = await suggest();
    await request("owner", "PUT", "/api/projects/:project/file", { path: "main.tex", content: initial.replace("prove", "") });
    expect((await review(comment)).statusCode).toBe(409);
    expect((await comments())[0].orphaned).toBe(true);
    await request("owner", "PUT", "/api/projects/:project/file", { path: "main.tex", content: initial });
    expect((await comments())[0].suggestion?.applicable).toBe(true);
    expect((await review(comment)).statusCode).toBe(200);
    expect(source()).toBe(initial.replace("prove", "suggest"));
  });

  it("serializes a simultaneous accept and reject instead of deciding twice", async () => {
    const comment = await suggest();
    const responses = await Promise.all([review(comment), review(comment, "reject")]);
    expect(responses.map((item) => item.statusCode).sort()).toEqual([200, 409]);
    const decided = (await comments())[0].suggestion!;
    expect(source()).toBe(decided.status === "accepted" ? initial.replace("prove", "suggest") : initial);
  });

  it("allows an author to add a suggestion later with an exact source binding", async () => {
    const start = initial.indexOf("prove");
    const created = await request("reader", "POST", "/api/projects/:project/comments", { path: "main.tex", content: "Please be cautious.", startOffset: start, endOffset: start + 5, sourceHash: hash(initial) });
    const comment = created.json().comment;
    const endpoint = `/api/projects/:project/comments/${comment.id}/suggestion`;
    expect((await request("writer", "POST", endpoint, { replacementText: "suggest", reviewerId: "owner", sourceHash: hash(initial) })).statusCode).toBe(403);
    expect((await request("reader", "POST", endpoint, { replacementText: "suggest", reviewerId: "owner", sourceHash: hash("stale") })).statusCode).toBe(409);
    expect((await request("reader", "POST", endpoint, { replacementText: "suggest", reviewerId: "owner", sourceHash: hash(initial) })).statusCode).toBe(200);
    expect((await comments())[0].content).toBe("Please be cautious.");
    expect((await request("reader", "POST", endpoint, { replacementText: "indicate", reviewerId: "owner", sourceHash: hash(initial) })).statusCode).toBe(409);
    expect(source()).toBe(initial);
  });

  it("rejects invalid reviewers and identical replacements without leaving a partial comment", async () => {
    const start = initial.indexOf("prove");
    for (const suggestion of [{ replacementText: "suggest", reviewerId: "reader" }, { replacementText: "prove", reviewerId: "owner" }]) {
      const result = await request("reader", "POST", "/api/projects/:project/comments", { path: "main.tex", startOffset: start, endOffset: start + 5, sourceHash: hash(initial), suggestion });
      expect(result.statusCode).toBe(400);
    }
    expect(await comments()).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) AS count FROM comment_mentions").get()).toEqual({ count: 0 });
  });

  it("keeps an application pending on source-write failure and completes a retry without applying twice", async () => {
    const comment = await suggest();
    const rename = fs.renameSync;
    const spy = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (String(to) === resolveSourcePath(config, projectId, "main.tex")) throw new Error("Simulated disk failure");
      return rename(from, to);
    });
    const failed = await review(comment);
    expect(failed.statusCode, failed.body).toBe(409); expect(source()).toBe(initial);
    expect(db.prepare("SELECT status, apply_update IS NOT NULL AS journal FROM comment_suggestions WHERE comment_id = ?").get(comment.id)).toEqual({ status: "pending", journal: 1 });
    const editDuringApply = await revise(comment, "indicate");
    expect(editDuringApply.statusCode).toBe(409); expect(editDuringApply.json().code).toBe("SUGGESTION_APPLYING");
    expect(db.prepare("SELECT replacement_text FROM comment_suggestions WHERE comment_id = ?").get(comment.id)).toEqual({ replacement_text: "suggest" });
    spy.mockRestore();
    expect((await review(comment)).statusCode).toBe(200);
    expect(source()).toBe(initial.replace("prove", "suggest"));
    expect((await comments())[0].suggestion?.status).toBe("accepted");
    expect((await review(comment)).statusCode).toBe(200);
    expect(source()).toBe(initial.replace("prove", "suggest"));
  });

  it("recovers a durable pending application after restart, even if the previous shutdown could not write source", async () => {
    const comment = await suggest();
    const rename = fs.renameSync;
    const spy = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (String(to) === resolveSourcePath(config, projectId, "main.tex")) throw new Error("Simulated disk failure");
      return rename(from, to);
    });
    expect((await review(comment)).statusCode).toBe(409);
    await app.close(); spy.mockRestore(); db.close();
    db = openDatabase(config); app = await buildApp(config, db, { logger: false }); await app.ready();
    expect((await review(comment)).statusCode).toBe(200);
    expect(source()).toBe(initial.replace("prove", "suggest"));
    expect((await comments())[0]).toMatchObject({ resolved: false, suggestion: { status: "accepted", decidedById: "owner" } });
  });

  it("recovers the decision when source was saved but the final database update failed", async () => {
    const comment = await suggest();
    db.exec(`CREATE TRIGGER fail_suggestion_decision BEFORE UPDATE OF status ON comment_suggestions
      WHEN NEW.status = 'accepted' BEGIN SELECT RAISE(FAIL, 'Simulated database failure'); END;`);
    expect((await review(comment)).statusCode).toBe(500);
    expect(source()).toBe(initial.replace("prove", "suggest"));
    expect(db.prepare("SELECT status, apply_update IS NOT NULL AS journal FROM comment_suggestions WHERE comment_id = ?").get(comment.id)).toEqual({ status: "pending", journal: 1 });
    await app.close(); db.exec("DROP TRIGGER fail_suggestion_decision"); db.close();
    db = openDatabase(config); app = await buildApp(config, db, { logger: false }); await app.ready();
    expect((await review(comment)).statusCode).toBe(200);
    expect(source()).toBe(initial.replace("prove", "suggest"));
    expect((await comments())[0].suggestion?.status).toBe("accepted");
  });

  it("recovers a pending application before an unrelated cold HTTP source write", async () => {
    const comment = await suggest();
    db.exec(`CREATE TRIGGER fail_suggestion_decision BEFORE UPDATE OF status ON comment_suggestions
      WHEN NEW.status = 'accepted' BEGIN SELECT RAISE(FAIL, 'Simulated database failure'); END;`);
    expect((await review(comment)).statusCode).toBe(500);
    await app.close(); db.exec("DROP TRIGGER fail_suggestion_decision"); db.close();
    db = openDatabase(config); app = await buildApp(config, db, { logger: false }); await app.ready();
    const result = await request("owner", "PUT", "/api/projects/:project/file", { path: "main.tex", content: "A later manual revision." });
    expect(result.statusCode, result.body).toBe(200);
    expect((await comments())[0].suggestion?.status).toBe("accepted");
    expect(source()).toBe("A later manual revision.");
  });

  it("refuses a pending replay without its CRDT base instead of guessing from matching source text", async () => {
    const comment = await suggest();
    db.exec(`CREATE TRIGGER fail_suggestion_decision BEFORE UPDATE OF status ON comment_suggestions
      WHEN NEW.status = 'accepted' BEGIN SELECT RAISE(FAIL, 'Simulated database failure'); END;`);
    expect((await review(comment)).statusCode).toBe(500);
    await app.close(); db.exec("DROP TRIGGER fail_suggestion_decision"); db.close();
    fs.unlinkSync(collaborationStatePath(config, projectId));
    db = openDatabase(config); app = await buildApp(config, db, { logger: false }); await app.ready();
    const result = await request("owner", "PUT", "/api/projects/:project/file", { path: "main.tex", content: "Do not replace source while recovery is uncertain." });
    expect(result.statusCode, result.body).toBe(409);
    expect(result.json().code).toBe("SUGGESTION_RECOVERY_FAILED");
    expect(source()).toBe(initial.replace("prove", "suggest"));
    expect(db.prepare("SELECT status FROM comment_suggestions WHERE comment_id = ?").get(comment.id)).toEqual({ status: "pending" });
  });
});
