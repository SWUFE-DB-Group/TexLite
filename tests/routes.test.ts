import { describe, expect, it } from "vitest";
import { isProjectHistoryState, projectIdFromPath, projectPath } from "../src/client/routes";

describe("client project routes", () => {
  it("uses a stable URL and parses the singular and plural aliases", () => {
    expect(projectPath("project/with spaces")).toBe("/project/project%2Fwith%20spaces");
    expect(projectIdFromPath("/project/abc-123")).toBe("abc-123");
    expect(projectIdFromPath("/projects/abc-123/")).toBe("abc-123");
    expect(projectIdFromPath("/project/abc%20123")).toBe("abc 123");
  });

  it("does not treat malformed or unrelated paths as projects", () => {
    expect(projectIdFromPath("/")).toBeNull();
    expect(projectIdFromPath("/projects")).toBeNull();
    expect(projectIdFromPath("/project/a/b")).toBeNull();
    expect(projectIdFromPath("/project/%E0%A4%A")).toBeNull();
  });

  it("validates route history markers before using browser back", () => {
    expect(isProjectHistoryState({ texliteRoute: "project", projectId: "p", fromDashboard: true })).toBe(true);
    expect(isProjectHistoryState({ texliteRoute: "project", projectId: "p", fromDashboard: false })).toBe(true);
    expect(isProjectHistoryState({ texliteRoute: "project", projectId: "p" })).toBe(false);
    expect(isProjectHistoryState({ texliteRoute: "dashboard" })).toBe(false);
  });
});
