import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { removeProjectSourcePath, resolveProjectMoveDestination, resolveSourcePath, safePathSegment, safeRelativePath, sourceRoot } from "../src/server/files.js";
import { createTestConfig } from "./helpers/testConfig.js";

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

  it.runIf(process.platform === "win32")("allows case-only renames but does not accept alternate casing as a project path", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "texlite project paths "));
    try {
      const config = createTestConfig(root);
      const source = sourceRoot(config, "paper");
      fs.mkdirSync(path.join(source, "Chapters"), { recursive: true });
      const original = path.join(source, "Chapters", "Main.tex");
      fs.writeFileSync(original, "keep the contents");
      fs.writeFileSync(path.join(source, "free.tex"), "do not overwrite");
      for (const alias of ["chapters/Main.tex", "Chapters/main.tex"]) {
        expect(() => resolveSourcePath(config, "paper", alias)).toThrow(expect.objectContaining({ code: "INVALID_PATH" }));
      }
      expect(() => resolveProjectMoveDestination(config, "paper", "Chapters/Main.tex", "free.tex"))
        .toThrow(expect.objectContaining({ code: "PATH_EXISTS" }));
      const destination = resolveProjectMoveDestination(config, "paper", "Chapters/Main.tex", "Chapters/main.tex");
      fs.renameSync(original, destination);
      expect(fs.readdirSync(path.dirname(destination))).toEqual(["main.tex"]);
      expect(fs.readFileSync(resolveSourcePath(config, "paper", "Chapters/main.tex"), "utf8")).toBe("keep the contents");
      expect(() => resolveSourcePath(config, "paper", "Chapters/Main.tex")).toThrow(expect.objectContaining({ code: "INVALID_PATH" }));
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it("does not apply Windows-only filename rules to Linux", () => {
    expect(safeRelativePath("AUX.tex", "linux")).toBe("AUX.tex");
    expect(safeRelativePath("draft./main:notes.tex", "linux")).toBe("draft./main:notes.tex");
  });

  it.runIf(process.platform === "win32")("leaves an entire source folder intact if Windows refuses to move it to trash", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "texlite blocked delete "));
    try {
      const config = createTestConfig(root);
      const folder = path.join(sourceRoot(config, "paper"), "figures");
      fs.mkdirSync(folder, { recursive: true });
      fs.writeFileSync(path.join(folder, "open.pdf"), "open PDF");
      fs.writeFileSync(path.join(folder, "other.pdf"), "other PDF");
      const rename = vi.spyOn(fs, "renameSync").mockImplementationOnce(() => {
        throw Object.assign(new Error("sharing violation"), { code: "EPERM" });
      });
      try {
        expect(() => removeProjectSourcePath(config, folder)).toThrow(expect.objectContaining({ code: "PROJECT_PATH_BUSY" }));
        expect(fs.readdirSync(folder).sort()).toEqual(["open.pdf", "other.pdf"]);
      } finally { rename.mockRestore(); }
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});
