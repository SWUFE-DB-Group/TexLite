import { describe, expect, it } from "vitest";
import { formatCommitTime, formatVersionTitle, generateUnifiedDiff } from "../src/client/diff.js";

describe("generateUnifiedDiff", () => {
  it("returns no changes for identical text", () => {
    const text = "line 1\nline 2\nline 3\n";
    const result = generateUnifiedDiff("main.tex", text, text);
    expect(result.hasChanges).toBe(false);
    expect(result.diffText).toBe("");
    expect(result.additions).toBe(0);
    expect(result.deletions).toBe(0);
  });

  it("handles CRLF normalization for identical text", () => {
    const result = generateUnifiedDiff("main.tex", "line 1\r\nline 2\r\n", "line 1\nline 2\n");
    expect(result.hasChanges).toBe(false);
    expect(result.diffText).toBe("");
  });

  it("produces unified diff format for single modification", () => {
    const oldText = "line 1\nline 2\nline 3\nline 4\nline 5\n";
    const newText = "line 1\nline 2\nline 3 modified\nline 4\nline 5\n";
    const result = generateUnifiedDiff("main.tex", oldText, newText, "v1", "current");

    expect(result.hasChanges).toBe(true);
    expect(result.additions).toBe(1);
    expect(result.deletions).toBe(1);
    expect(result.diffText).toContain("--- a/main.tex (v1)");
    expect(result.diffText).toContain("+++ b/main.tex (current)");
    expect(result.diffText).toContain("@@ -1,5 +1,5 @@");
    expect(result.diffText).toContain("-line 3");
    expect(result.diffText).toContain("+line 3 modified");
  });

  it("handles added content to empty file", () => {
    const result = generateUnifiedDiff("new.tex", "", "first line\nsecond line\n");
    expect(result.hasChanges).toBe(true);
    expect(result.additions).toBe(2);
    expect(result.deletions).toBe(0);
    expect(result.diffText).toContain("@@ -0,0 +1,2 @@");
    expect(result.diffText).toContain("+first line");
    expect(result.diffText).toContain("+second line");
  });

  it("handles deleted content from file", () => {
    const result = generateUnifiedDiff("deleted.tex", "line 1\nline 2\n", "");
    expect(result.hasChanges).toBe(true);
    expect(result.additions).toBe(0);
    expect(result.deletions).toBe(2);
    expect(result.diffText).toContain("@@ -1,2 +0,0 @@");
    expect(result.diffText).toContain("-line 1");
    expect(result.diffText).toContain("-line 2");
  });

  it("groups distant changes into separate hunks", () => {
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
    const oldText = lines.join("\n");
    const newLines = [...lines];
    newLines[4] = "line 5 changed";
    newLines[24] = "line 25 changed";
    const newText = newLines.join("\n");

    const result = generateUnifiedDiff("doc.tex", oldText, newText);
    expect(result.hasChanges).toBe(true);
    expect(result.additions).toBe(2);
    expect(result.deletions).toBe(2);
    const hunkHeaders = result.diffText.match(/@@ -\d+,\d+ \+\d+,\d+ @@/g);
    expect(hunkHeaders).toHaveLength(2);
  });

  it("preserves blank lines within changes", () => {
    const oldText = "section 1\n\nsection 2\n";
    const newText = "section 1\nmiddle line\nsection 2\n";
    const result = generateUnifiedDiff("blank.tex", oldText, newText);
    expect(result.hasChanges).toBe(true);
    expect(result.additions).toBe(1);
    expect(result.deletions).toBe(1);
    expect(result.diffText).toContain("+middle line");
  });
});

describe("formatCommitTime", () => {
  it("formats same day time with hours and minutes", () => {
    const now = new Date();
    const formatted = formatCommitTime(now.toISOString());
    expect(formatted).toMatch(/^\d{1,2}:\d{2}/);
  });

  it("handles fallback on invalid date", () => {
    expect(formatCommitTime("not-a-date")).toBe("not-a-date");
  });
});

describe("formatVersionTitle", () => {
  const fakeIso = new Date().toISOString();

  it("returns explicit user label when present", () => {
    const title = formatVersionTitle({
      label: "Release v1.0",
      reason: "checkpoint",
      createdAt: fakeIso,
      changedPaths: ["main.tex"]
    }, "Automatic save");
    expect(title).toBe("Release v1.0");
  });

  it("formats single changed file as fileName (time)", () => {
    const title = formatVersionTitle({
      label: null,
      reason: "autosave",
      createdAt: fakeIso,
      changedPaths: ["src/sections/intro.tex"]
    }, "Automatic save");
    expect(title).toMatch(/^intro\.tex \(\d{1,2}:\d{2}/);
  });

  it("formats two changed files as file1, file2 (time)", () => {
    const title = formatVersionTitle({
      label: null,
      reason: "autosave",
      createdAt: fakeIso,
      changedPaths: ["main.tex", "refs.bib"]
    }, "Automatic save");
    expect(title).toMatch(/^main\.tex, refs\.bib \(\d{1,2}:\d{2}/);
  });

  it("formats three or more changed files as file1 +count (time)", () => {
    const title = formatVersionTitle({
      label: null,
      reason: "autosave",
      createdAt: fakeIso,
      changedPaths: ["main.tex", "refs.bib", "appendix.tex"]
    }, "Automatic save");
    expect(title).toMatch(/^main\.tex \+2 \(\d{1,2}:\d{2}/);
  });

  it("formats author @ time when no files changed", () => {
    const title = formatVersionTitle({
      label: null,
      reason: "settings",
      createdAt: fakeIso,
      changedPaths: [],
      author: { name: "Administrator" }
    }, "Settings updated");
    expect(title).toMatch(/^Administrator @ \d{1,2}:\d{2}/);
  });

  it("falls back to defaultTitle (time) when no files changed and no author", () => {
    const title = formatVersionTitle({
      label: null,
      reason: "autosave",
      createdAt: fakeIso,
      changedPaths: []
    }, "Automatic save");
    expect(title).toMatch(/^Automatic save \(\d{1,2}:\d{2}/);
  });
});
