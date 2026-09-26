import { describe, expect, it } from "vitest";
import { projectLatexmkrcCandidates } from "../src/client/workspace/projectLatexmkrc";

describe("project latexmkrc discovery", () => {
  const files = [
    { path: "chapter/latexmkrc", type: "file" },
    { path: ".latexmkrc", type: "file" },
    { path: "latexmkrc", type: "file" },
    { path: "main.tex", type: "file" }
  ] as const;

  it("prefers root latexmkrc over .latexmkrc for a new selection", () => {
    expect(projectLatexmkrcCandidates(files, null)).toEqual(["latexmkrc", ".latexmkrc", "chapter/latexmkrc"]);
  });

  it("keeps an existing custom selection visible until its file is removed", () => {
    expect(projectLatexmkrcCandidates([...files, { path: "build.rc", type: "file" }], "build.rc")).toContain("build.rc");
    expect(projectLatexmkrcCandidates(files, "build.rc")).not.toContain("build.rc");
  });
});
