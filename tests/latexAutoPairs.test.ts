import { describe, expect, it } from "vitest";
import { EditorState, Transaction } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { history, undo } from "@codemirror/commands";
import { latexAutoPair, latexAutoPairAtCursor, latexAutoPairInput, latexSkippedBracePair } from "../src/client/latexAutoPairs";

describe("LaTeX auto pairs", () => {
  it("emits one transaction and undoes input plus auto pair together", () => {
    const source = String.raw`\left`;
    let state = EditorState.create({ doc: source, selection: { anchor: source.length }, extensions: [history()] });
    const updates: Transaction[] = [];
    const view = {
      get state() { return state; },
      composing: false,
      dispatch(transaction: Transaction) { updates.push(transaction); state = transaction.state; }
    } as unknown as EditorView;
    expect(latexAutoPairInput(view, source.length, source.length, "(", () => state.update({
      changes: { from: source.length, insert: "(" }, selection: { anchor: source.length + 1 }, userEvent: "input.type"
    }))).toBe(true);
    expect(updates).toHaveLength(1);
    expect(state.doc.toString()).toBe(String.raw`\left(\right)`);
    expect(state.selection.main.head).toBe(source.length + 1);
    expect(undo(view)).toBe(true);
    expect(state.doc.toString()).toBe(source);
  });

  it("pairs skipped environment braces in the original transaction", () => {
    const source = String.raw`\begin{figure}`;
    const state = EditorState.create({ doc: source, selection: { anchor: source.length - 1 }, extensions: [latexSkippedBracePair] });
    const transaction = state.update({ selection: { anchor: source.length }, userEvent: "input" });
    expect(transaction.newDoc.toString()).toBe(source + "\n\t\n\\end{figure}");
    expect(transaction.newSelection.main.head).toBe(source.length + 2);
  });

  it("does not guess a closing delimiter for an invisible left delimiter", () => {
    const source = String.raw`\left`;
    expect(latexAutoPair(source, source.length, source.length, ".")).toBeNull();
  });
  it("closes an environment after the closing brace is typed", () => {
    const source = "\\begin{itemize";
    const pair = latexAutoPair(source, source.length, source.length, "}");
    expect(pair).toEqual({ insert: "\n\t\n\\end{itemize}", cursorOffset: 2, kind: "environment" });
  });

  it("keeps the existing indentation for the body and closing command", () => {
    const source = "  \\begin{figure";
    const pair = latexAutoPair(source, source.length, source.length, "}");
    expect(pair).toEqual({ insert: "\n  \t\n  \\end{figure}", cursorOffset: 4, kind: "environment" });
  });

  it("does not duplicate an immediately following closing environment", () => {
    const source = "\\begin{document\n\\end{document}";
    const from = "\\begin{document".length;
    expect(latexAutoPair(source, from, from, "}")).toBeNull();
  });

  it("does not reuse an outer closing environment for a nested completion", () => {
    const source = "\\begin{itemize}\n  \\begin{itemize\n\\end{itemize}";
    const from = source.indexOf("\n  \\begin{itemize") + "\n  \\begin{itemize".length;
    expect(latexAutoPair(source, from, from, "}")).toEqual({
      insert: "\n  \t\n  \\end{itemize}", cursorOffset: 4, kind: "environment"
    });
  });

  it("recognizes an existing matching close beyond the next line", () => {
    const source = "\\begin{figure\n  body\n\\end{figure}";
    const from = "\\begin{figure".length;
    expect(latexAutoPair(source, from, from, "}")).toBeNull();
    const skippedBraceSource = "\\begin{figure}\n  body\n\\end{figure}";
    expect(latexAutoPairAtCursor(skippedBraceSource, "\\begin{figure}".length)).toBeNull();
  });

  it("does not pair inside opaque source, but resumes after a completed inline literal", () => {
    const literal = "\\begin{lstlisting}\n\\begin{itemize";
    expect(latexAutoPair(literal, literal.length, literal.length, "}")).toBeNull();
    const afterInlineLiteral = String.raw`\verb|%|
\begin{itemize`;
    expect(latexAutoPair(afterInlineLiteral, afterInlineLiteral.length, afterInlineLiteral.length, "}"))
      .toMatchObject({ kind: "environment" });
  });

  it("can complete an environment after a close-bracket handler moves over its brace", () => {
    const source = "\\begin{itemize}";
    expect(latexAutoPairAtCursor(source, source.length)).toEqual({
      insert: "\n\t\n\\end{itemize}",
      cursorOffset: 2,
      kind: "environment"
    });
  });

  it("pairs scalable delimiters without affecting ordinary text", () => {
    const source = "\\left";
    expect(latexAutoPair(source, source.length, source.length, "(")).toEqual({
      insert: "\\right)",
      cursorOffset: 0,
      kind: "delimiter"
    });
    const text = "text \\begin{itemize";
    expect(latexAutoPair(text, text.length, text.length, "}")).toBeNull();
  });

  it("does not react to replacements", () => {
    const source = "\\begin{itemize";
    expect(latexAutoPair(source, 0, source.length, "}")).toBeNull();
  });
});
