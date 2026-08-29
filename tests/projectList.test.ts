import { describe, expect, it } from "vitest";
import { projectInitial } from "../src/client/pages/ProjectListRow";

describe("project list avatars", () => {
  it("uses the first visible character from Latin and Chinese project names", () => {
    expect(projectInitial("demo")).toBe("D");
    expect(projectInitial(" 论文初稿 ")).toBe("论");
  });

  it("uses a safe fallback when no project name is available", () => {
    expect(projectInitial("   ")).toBe("?");
  });
});
