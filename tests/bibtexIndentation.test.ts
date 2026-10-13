import { describe, expect, it } from "vitest";
import { getIndentation, IndentContext, indentOnInput, indentRange, indentUnit } from "@codemirror/language";
import { EditorState, Transaction } from "@codemirror/state";
import { bibtexLanguage } from "../src/client/bibtex";

function stateFor(source: string, unit = "  ") {
  return EditorState.create({ doc: source, extensions: [bibtexLanguage, indentUnit.of(unit), indentOnInput()] });
}

describe("BibTeX indentation", () => {
  it.each([
    ["@misc{key,\n  title = {A}\n}", [0, 2, 0]],
    ["@misc(key,\n  title = {A}\n)", [0, 2, 0]],
    ["@string{venue =\n  {A}\n}", [0, 2, 0]],
    ['@string(venue =\n  "A"\n)', [0, 2, 0]],
    ['@preamble{\n  "A"\n}', [0, 2, 0]],
    ["@preamble(\n  {A}\n)", [0, 2, 0]],
    ["@misc{key,\n  title = {\n    A\n  }\n}", [0, 2, 4, 2, 0]],
    ["@misc{key,\n  author = {\n    {Research and Development}\n  }\n}", [0, 2, 4, 2, 0]],
    ["@misc{key,\n  title = {\n    {\n      ISO/IEC\n    }\n  }\n}", [0, 2, 4, 6, 4, 2, 0]]
  ] as const)("dedents the matching closers in %s", (source, expected) => {
    const state = stateFor(source);
    expect(Array.from({ length: state.doc.lines }, (_, index) => getIndentation(state, state.doc.line(index + 1).from)))
      .toEqual(expected);
  });

  it("reindents a complete entry without changing protected value text", () => {
    const source = "@misc(key,\ntitle = {\n{ISO/IEC}\n}\n)";
    const state = stateFor(source);
    const indented = state.update({ changes: indentRange(state, 0, state.doc.length) }).state;
    expect(indented.doc.toString()).toBe("@misc(key,\n  title = {\n    {ISO/IEC}\n  }\n)");
  });

  it.each([
    ["@misc{key,}", "}", 2],
    ["@misc(key,)", ")", 2],
    ["@misc{key,\n  title = {}}", "}}", 4]
  ])("indents a new line before the closer in %s", (source, ending, expected) => {
    const state = stateFor(source);
    const position = source.length - ending.length;
    expect(getIndentation(new IndentContext(state, { simulateBreak: position, simulateDoubleBreak: true }), position))
      .toBe(expected);
  });

  it.each([
    ["@misc{key,\n  title = {A}\n  ", "}", "@misc{key,\n  title = {A}\n}"],
    ["@misc(key,\n  title = {A}\n  ", ")", "@misc(key,\n  title = {A}\n)"],
    ["@misc{key,\n  title = {\n    A\n    ", "}", "@misc{key,\n  title = {\n    A\n  }"]
  ])("dedents the typed closer in %s", (source, closer, expected) => {
    const state = stateFor(source).update({ selection: { anchor: source.length } }).state;
    const typed = state.update({
      changes: { from: state.doc.length, insert: closer },
      selection: { anchor: state.doc.length + 1 },
      annotations: Transaction.userEvent.of("input.type")
    }).state;
    expect(typed.doc.toString()).toBe(expected);
  });
});
