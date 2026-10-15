import { describe, expect, it } from "vitest";
import { ApiError } from "../src/client/api";
import type { Comment } from "../src/client/types";
import { fileCommentsAfterFailure } from "../src/client/workspace/useProjectComments";

const comment: Comment = {
  id: "thread", filePath: "main.tex", authorId: "author", authorUsername: "author", authorDisplayName: "Author",
  selectedText: "Source", startOffset: 0, endOffset: 6, startLine: 1, endLine: 1,
  content: "Review", resolved: false, orphaned: false, resolvedById: null, resolvedByUsername: null,
  resolvedByDisplayName: null, resolvedAt: null, createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z", editedAt: null, replies: []
};
const cached = { filePath: "main.tex", comments: [comment], loading: true, error: "" };

describe("file comment load failures", () => {
  it.each([
    new ApiError("Network unavailable", 0, "NETWORK_ERROR"),
    new ApiError("Server unavailable", 503),
    new ApiError("Invalid response", 200, "INVALID_RESPONSE")
  ])("preserves same-file comments after a temporary failure: %s", (error) => {
    const result = fileCommentsAfterFailure(cached, "main.tex", error);
    expect(result).toEqual({ ...cached, loading: false, error: error.message });
    expect(result.comments).toBe(cached.comments);
    expect(cached.loading).toBe(true);
    expect(cached.error).toBe("");
  });

  it("never carries another file's cached comments into a failed load", () => {
    expect(fileCommentsAfterFailure(cached, "chapter.tex", new Error("Failed")))
      .toEqual({ filePath: "chapter.tex", comments: [], loading: false, error: "Failed" });
  });

  it("records an initial-load error instead of a successful empty resource", () => {
    expect(fileCommentsAfterFailure({ filePath: "", comments: [], loading: true, error: "" }, "main.tex", new Error("Failed")))
      .toEqual({ filePath: "main.tex", comments: [], loading: false, error: "Failed" });
  });

  it.each([401, 403, 404])("clears cached contents on an explicit access rejection (%s)", (status) => {
    expect(fileCommentsAfterFailure(cached, "main.tex", new ApiError("Access denied", status)))
      .toEqual({ filePath: "main.tex", comments: [], loading: false, error: "Access denied" });
  });
});
