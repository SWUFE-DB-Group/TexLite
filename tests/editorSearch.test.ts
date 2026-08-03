import { EditorState } from "@codemirror/state";
import { SearchQuery } from "@codemirror/search";
import { describe, expect, it } from "vitest";
import { countSearchMatches, searchQuerySignature } from "../src/client/editorSearch";

describe("editor search helpers", () => {
  const state = EditorState.create({ doc: "section Section subsection section" });

  it("counts all matches using the active search options", () => {
    expect(countSearchMatches(state, new SearchQuery({ search: "section" }))).toBe(4);
    expect(countSearchMatches(state, new SearchQuery({ search: "section", caseSensitive: true }))).toBe(3);
    expect(countSearchMatches(state, new SearchQuery({ search: "section", wholeWord: true }))).toBe(3);
  });

  it("changes its cache signature when matching options change", () => {
    const plain = new SearchQuery({ search: "section" });
    const regexp = new SearchQuery({ search: "section", regexp: true });
    expect(searchQuerySignature(plain)).not.toBe(searchQuerySignature(regexp));
  });
});
