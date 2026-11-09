import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import i18n from "../src/client/i18n";
import { WordCountDialog } from "../src/client/workspace/WordCountDialog";
import { countPlainText, usesPlainTextCount } from "../src/client/workspace/plainTextCount";

vi.mock("../src/client/Dialog", () => ({
  Modal: ({ children }: { children: ReactNode }) => createElement("section", null, children)
}));

describe("plain text word count", () => {
  it.each([
    ["", 0, 0],
    ["   \n\t ", 0, 0],
    ["Two words", 2, 8],
    ["# Title\n\n- **bold** item -- done", 4, 17],
    ["See https://example.com/a?b=1 now", 3, 24],
    ["don't stop", 2, 8],
    ["中文，统计。", 4, 4],
    ["使用 Harper 检查", 5, 10],
    ["かなカナ", 4, 4],
    ["한국어 문장", 2, 5],
    ["𠮷野 ok", 3, 4]
  ])("counts %j", (text, words, characters) => {
    expect(countPlainText(text)).toEqual({ words, characters });
  });

  it("applies only to Markdown and plain text files", () => {
    for (const path of ["main.tex", "pkg.sty", "doc.cls", "refs.bib", "data.json", "Makefile", "md", "notes.txt.bak"]) expect(usesPlainTextCount(path)).toBe(false);
    for (const path of ["README.md", "docs/A.MD", "notes.txt"]) expect(usesPlainTextCount(path)).toBe(true);
    expect(usesPlainTextCount("")).toBe(false);
  });

  it("shows only the browser totals without TeXcount details", async () => {
    await i18n.changeLanguage("en");
    const html = renderToStaticMarkup(createElement(WordCountDialog, {
      open: true, mode: "full", path: "README.md", busy: false, error: "", result: null,
      plainResult: { words: 1234, characters: 5678 }, onOpenChange: () => {}
    }));
    expect(html).toContain("1,234");
    expect(html).toContain("5,678");
    expect(html).toContain("Counted in your browser");
    expect(html).not.toContain("TeXcount");
    expect(html).not.toContain("word-count-breakdown");
  });
});
