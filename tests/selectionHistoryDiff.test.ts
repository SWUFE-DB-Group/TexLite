import { describe, expect, it } from "vitest";
import { generateSelectionHistoryDiff } from "../src/client/selectionHistoryDiff.js";

describe("selection-history semantic diff", () => {
  it("highlights a local rewrite without repeating a long unchanged LaTeX paragraph", () => {
    const prefix = "The evaluation discusses the reproducibility of our method in realistic deployments. ".repeat(12);
    const suffix = " The conclusion keeps the discussion grounded in the submitted evidence.".repeat(12);
    const previous = `${prefix}The abstract is rough but accurate.${suffix}`;
    const current = `${prefix}The abstract is concise but accurate.${suffix}`;

    const diff = generateSelectionHistoryDiff(previous, current);
    const previousView = diff.previous.map((piece) => piece.text).join("");
    const currentView = diff.current.map((piece) => piece.text).join("");

    expect(diff.hasChanges).toBe(true);
    expect(diff.previous).toContainEqual(expect.objectContaining({ kind: "deletion", text: "rough" }));
    expect(diff.current).toContainEqual(expect.objectContaining({ kind: "addition", text: "concise" }));
    expect(diff.previous.some((piece) => piece.kind === "omitted")).toBe(true);
    expect(previousView.length).toBeLessThan(previous.length / 3);
    expect(currentView.length).toBeLessThan(current.length / 3);
  });

  it("retains the full nearby context for a short selection", () => {
    const previous = "\\section{Abstract}\nThe rough abstract supports a compact result.\n";
    const current = "\\section{Abstract}\nThe concise abstract supports a compact result.\n";
    const diff = generateSelectionHistoryDiff(previous, current);

    expect(diff.previous.map((piece) => piece.text).join("")).toContain("\\section{Abstract}");
    expect(diff.previous).toContainEqual(expect.objectContaining({ kind: "deletion", text: "rough" }));
    expect(diff.current).toContainEqual(expect.objectContaining({ kind: "addition", text: "concise" }));
    expect(diff.previous.some((piece) => piece.kind === "omitted")).toBe(false);
  });

  it("does not create a diff for equivalent content after line-ending normalization", () => {
    const diff = generateSelectionHistoryDiff("One line\r\nSecond line\r\n", "One line\nSecond line\n");
    expect(diff).toEqual({ previous: [], current: [], additions: 0, deletions: 0, hasChanges: false });
  });
});
