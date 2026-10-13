import { CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { EditorState } from "@codemirror/state";
import { describe, expect, it, vi } from "vitest";
import { bibtexCompletionSource, bibtexLanguage, entryTypes, fieldRequirements, snippets, validEntryTypes } from "../src/client/bibtex";
import * as documentValues from "../src/client/bibtex/documentValues";

function complete(marked: string) {
  const position = marked.indexOf("▮");
  if (position < 0) throw new Error("Missing cursor marker");
  const state = EditorState.create({ doc: marked.replace("▮", ""), extensions: [bibtexLanguage] });
  return { state, position, result: bibtexCompletionSource(new CompletionContext(state, position, true)) };
}

function updateResult(result: CompletionResult, state: EditorState, from: number, to: number, position = to) {
  if (!result.update) throw new Error("Missing incremental completion update");
  return result.update(result, from, to, new CompletionContext(state, position, false));
}

describe("BibTeX completion quality", () => {
  it("uses the same entry types for completion and validation", () => {
    expect(new Set(entryTypes)).toEqual(validEntryTypes);
    expect(entryTypes).toHaveLength(validEntryTypes.size);
    for (const type of Object.keys(fieldRequirements)) expect(validEntryTypes.has(type), type).toBe(true);
    for (const snippet of snippets) expect(validEntryTypes.has(snippet.label.slice(1)), snippet.label).toBe(true);
    const { result } = complete("@▮");
    expect(new Set(result!.options.map((option) => option.label.slice(1)))).toEqual(validEntryTypes);
  });

  it.each(["dataset", "software", "report", "thesis", "xdata", "mvbook"])("offers the valid extended type @%s", (type) => {
    const { result } = complete(`@${type.slice(0, 2)}▮`);
    expect(result!.options).toContainEqual(expect.objectContaining({ label: `@${type}`, apply: `@${type}` }));
  });

  it.each(["{Nat▮}", '"Nat▮"'])("does not offer the in-progress literal %s as its own completion", (value) => {
    const { result } = complete(`@article{source, journal = {Nature}}\n@article{target, journal = ${value}}`);
    expect(result!.options.map((option) => option.label)).toContain("Nature");
    expect(result!.options.map((option) => option.label)).not.toContain("Nat");
  });

  it.each([
    ["author", "{John Smith and Gr▮}", "Gr", "Grace Hopper"],
    ["editor", '"John Smith and Gr▮"', "Gr", "Grace Hopper"],
    ["month", "{jan▮}", "jan", "feb"],
    ["crossref", "{source▮}", "source", "target"]
  ])("excludes no-op %s values without hiding useful alternatives", (field, value, excluded, included) => {
    const { result } = complete(`@article{source, author = {Grace Hopper}, editor = {Grace Hopper}}\n@article{target, ${field} = ${value}}`);
    expect(result!.options.map((option) => option.label)).not.toContain(excluded);
    expect(result!.options.map((option) => option.label)).toContain(included);
  });

  it("compares inserted text, retaining a literal completion that adds necessary braces", () => {
    const { result } = complete("@article{source, journal = {Na}}\n@article{target, journal = Na▮}");
    expect(result!.options).toContainEqual(expect.objectContaining({ label: "Na", apply: "{Na}" }));
  });

  it("omits an unchanged bare macro but keeps the macro while it is incomplete", () => {
    const source = "@string{venue = {Nature}}\n@article{target, journal = ";
    expect(complete(source + "ven▮}").result!.options.map((option) => option.label)).toContain("venue");
    expect(complete(source + "venue▮}").result!.options.map((option) => option.label)).not.toContain("venue");
  });

  it("returns no value popup when the only candidate would leave the document unchanged", () => {
    expect(complete("@article{target, year = {2026▮}}").result).toBeNull();
  });

  it("updates cached choices while typing or deleting without rescanning document values", () => {
    const collect = vi.spyOn(documentValues, "collectDocumentValues");
    try {
      const { state, position, result } = complete("@article{source, journal = {Nature Communications}}\n@article{target, journal = {Nat▮}}");
      expect(collect).toHaveBeenCalledTimes(1);
      expect(result!.options.map((option) => option.label)).not.toContain("Nat");
      expect(result!.options.map((option) => option.label)).toContain("Nature");

      const typed = state.update({ changes: { from: position, insert: "ure" } }).state;
      const validFor = result!.validFor as Exclude<CompletionResult["validFor"], RegExp | undefined>;
      expect(validFor("Natu", result!.from, result!.to! + 1, state)).toBe(false);
      const partialState = state.update({ changes: { from: position, insert: "u" } }).state;
      const partial = updateResult(result!, partialState, result!.from, result!.to! + 1)!;
      const partialValidFor = partial.validFor as Exclude<CompletionResult["validFor"], RegExp | undefined>;
      expect(partialValidFor("Natur", partial.from, partial.to! + 1, partialState)).toBe(true);
      expect(validFor("Nature", result!.from, result!.to! + 3, typed)).toBe(false);
      const updated = updateResult(result!, typed, result!.from, result!.to! + 3)!;
      expect(updated.options.map((option) => option.label)).not.toContain("Nature");
      expect(updated.options.map((option) => option.label)).toContain("Nature Communications");

      const deleted = typed.update({ changes: { from: position + 2, to: position + 3 } }).state;
      const nextValidFor = updated.validFor as Exclude<CompletionResult["validFor"], RegExp | undefined>;
      expect(nextValidFor("Natur", updated.from, updated.to! - 1, deleted)).toBe(false);
      const refreshed = updateResult(updated, deleted, updated.from, updated.to! - 1)!;
      expect(refreshed.options.map((option) => option.label)).toContain("Nature");
      expect(collect).toHaveBeenCalledTimes(1);
    } finally {
      collect.mockRestore();
    }
  });

  it("restores a suppressed option after a case-only change", () => {
    const { state, result } = complete("@article{target, journal = {Nature▮}}");
    expect(result!.options.map((option) => option.label)).not.toContain("Nature");
    const edited = state.update({ changes: { from: result!.from, to: result!.to!, insert: "nature" } }).state;
    const validFor = result!.validFor as Exclude<CompletionResult["validFor"], RegExp | undefined>;
    expect(validFor("nature", result!.from, result!.to!, edited)).toBe(false);
    expect(updateResult(result!, edited, result!.from, result!.to!)!.options.map((option) => option.label)).toContain("Nature");
  });

  it("abandons cached person choices when the next top-level separator starts", () => {
    const { state, position, result } = complete("@article{source, author = {Ada Lovelace and Grace Hopper}}\n@article{target, author = {Ada▮}}");
    const typed = state.update({ changes: { from: position, insert: " and Gr" } }).state;
    expect(updateResult(result!, typed, result!.from, result!.to! + 7)).toBeNull();
    const next = bibtexCompletionSource(new CompletionContext(typed, position + 7, false))!;
    expect(next.options.map((option) => option.label)).toContain("Grace Hopper");
    expect(next.from).toBe(position + 5);
  });
});
