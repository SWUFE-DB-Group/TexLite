import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { WordCountDialog } from "../src/client/workspace/WordCountDialog";
import type { WordCountResult } from "../src/client/types";
import i18n from "../src/client/i18n";

vi.mock("../src/client/Dialog", () => ({
  Modal: ({ children }: { children: ReactNode }) => createElement("section", null, children)
}));

describe("word-count units", () => {
  it.each([0, 1, 2])("uses the raw count for each unit, including mixed quantities (%i)", async (count) => {
    await i18n.changeLanguage("en");
    const result: WordCountResult = {
      mode: "full", path: "main.tex", textWords: count, headerWords: 1, captionWords: 2, totalWords: count + 3,
      headers: 1, floats: count, inlineMath: 1, displayMath: count, totalCharacters: 12, files: count, parserErrors: count
    };
    const html = renderToStaticMarkup(createElement(WordCountDialog, {
      open: true, mode: "full", path: "main.tex", busy: false, error: "", result, onOpenChange: () => {}
    }));
    const units = [...html.matchAll(/<dd>\d+<small>(.*?)<\/small><\/dd>/g)].map((match) => match[1]);
    expect(units).toEqual([
      count === 1 ? "word" : "words", "word", "words", count === 1 ? "item" : "items",
      "expression", count === 1 ? "expression" : "expressions", count === 1 ? "item" : "items"
    ]);
    if (count > 0) expect(html).toContain(`TeXcount reported ${count} parsing ${count === 1 ? "issue" : "issues"}.`);
  });
});
