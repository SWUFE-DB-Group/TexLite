import { describe, expect, it } from "vitest";
import {
  isProjectHistoryState, mentionIdFromReturn, mentionIdFromSearch, projectIdFromPath, projectIdFromReturn, projectLoginPath, projectPath
} from "../src/client/routes";

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

  it("round-trips only internal project destinations through login", () => {
    expect(projectLoginPath("abc-123")).toBe("/?return=%2Fproject%2Fabc-123");
    expect(projectIdFromReturn("?return=%2Fproject%2Fabc-123")).toBe("abc-123");
    expect(projectIdFromReturn("?return=https%3A%2F%2Fexample.com%2Fproject%2Fabc")).toBeNull();
    expect(projectIdFromReturn("?return=%2Fadmin")).toBeNull();
    expect(projectIdFromReturn("?return=%2Fproject%2Fa%2Fb")).toBeNull();
  });

  it("retains one personal mention target through project and login routes", () => {
    expect(projectPath("abc-123", "mention-1")).toBe("/project/abc-123?mention=mention-1");
    expect(mentionIdFromSearch("?mention=mention-1")).toBe("mention-1");
    expect(mentionIdFromSearch("?mention=" + "x".repeat(129))).toBeNull();
    expect(projectLoginPath("abc-123", "mention-1")).toBe("/?return=%2Fproject%2Fabc-123%3Fmention%3Dmention-1");
    expect(projectIdFromReturn("?return=%2Fproject%2Fabc-123%3Fmention%3Dmention-1")).toBe("abc-123");
    expect(mentionIdFromReturn("?return=%2Fproject%2Fabc-123%3Fmention%3Dmention-1")).toBe("mention-1");
  });

  it("keeps navigation inside a configured deployment base path", () => {
    const basePath = "/tools/texlite";
    expect(projectPath("abc-123", null, basePath)).toBe("/tools/texlite/project/abc-123");
    expect(projectIdFromPath("/tools/texlite/project/abc-123", basePath)).toBe("abc-123");
    expect(projectIdFromPath("/project/abc-123", basePath)).toBeNull();
    expect(projectLoginPath("abc-123", "mention-1", basePath))
      .toBe("/tools/texlite/?return=%2Ftools%2Ftexlite%2Fproject%2Fabc-123%3Fmention%3Dmention-1");
    const search = "?return=%2Ftools%2Ftexlite%2Fproject%2Fabc-123%3Fmention%3Dmention-1";
    expect(projectIdFromReturn(search, basePath)).toBe("abc-123");
    expect(mentionIdFromReturn(search, basePath)).toBe("mention-1");
    expect(projectIdFromReturn("?return=%2Fproject%2Fabc-123", basePath)).toBeNull();
  });

  it("validates route history markers before using browser back", () => {
    expect(isProjectHistoryState({ texliteRoute: "project", projectId: "p", fromDashboard: true })).toBe(true);
    expect(isProjectHistoryState({ texliteRoute: "project", projectId: "p", fromDashboard: false })).toBe(true);
    expect(isProjectHistoryState({ texliteRoute: "project", projectId: "p" })).toBe(false);
    expect(isProjectHistoryState({ texliteRoute: "dashboard" })).toBe(false);
  });
});
