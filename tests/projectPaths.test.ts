import { describe, expect, it } from "vitest";
import { safePathSegment, safeRelativePath } from "../src/server/files.js";

describe("Windows project paths", () => {
  it.each([
    "AUX.tex", "figures/LPT².png", "figures/CON .tex", "draft..", "folder /main.tex", " main.tex",
    "main.tex:extra", "C:main.tex", "C:/main.tex", "\\\\host\\share\\main.tex",
    "bad?.txt", "control\u001f.txt"
  ])("rejects paths the Windows filesystem cannot address as ordinary files: %j", (name) => {
    expect(() => safeRelativePath(name, "win32")).toThrow(expect.objectContaining({ code: "INVALID_PATH" }));
  });

  it("keeps valid case, Unicode, and spaces, while rejecting reserved Git paths", () => {
    expect(safeRelativePath("论文\\Draft Files\\Main.tex", "win32")).toBe("论文/Draft Files/Main.tex");
    expect(() => safeRelativePath(".GIT/config", "win32")).toThrow(expect.objectContaining({ code: "RESERVED_PATH" }));
  });

  it.runIf(process.platform === "win32")("rejects trailing spaces in direct rename requests", () => {
    expect(() => safePathSegment("Main.tex ")).toThrow(expect.objectContaining({ code: "INVALID_PATH" }));
  });

  it("does not apply Windows-only filename rules to Linux", () => {
    expect(safeRelativePath("AUX.tex", "linux")).toBe("AUX.tex");
    expect(safeRelativePath("draft./main:notes.tex", "linux")).toBe("draft./main:notes.tex");
  });
});
