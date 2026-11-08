import { describe, expect, it } from "vitest";
import { splitBibtexNames, truncateBibtexNames } from "../src/shared/bibtexNames";
import { splitAuthors } from "../src/client/bibtex/documentValues";

describe("BibTeX name lists", () => {
  it("splits on a whitespace-delimited `and` in any case, keeping names as written", () => {
    expect(splitBibtexNames("Vaswani, Ashish and Noam Shazeer\n AND  Parmar, Niki")).toEqual({
      names: ["Vaswani, Ashish", "Noam Shazeer", "Parmar, Niki"], others: false
    });
  });

  it("uses the editor's separator rules, so display and completion agree", () => {
    for (const value of [
      "A and B", "A AND\tB", "{Barnes and Noble} and C", "Anderson, Sandy and Band, Ann",
      "G{\\\"o}del and Erd{\\H{o}}s", "A and", "A and B and"
    ]) {
      expect(splitBibtexNames(value).names).toEqual(splitAuthors(value).map((name) => name.replace(/^\{(.*)\}$/, "$1")));
    }
    // A list still being typed never turns the trailing `and` into a name.
    expect(splitBibtexNames("Smith, A. and").names).toEqual(["Smith, A."]);
  });

  it("does not split inside braces or inside words containing `and`", () => {
    expect(splitBibtexNames("{Barnes and Noble} and Anderson, Sandy and Brandt, A.").names)
      .toEqual(["Barnes and Noble", "Anderson, Sandy", "Brandt, A."]);
    expect(splitBibtexNames("{\\\"O}zt{\\\"u}rk, Ay{\\c{s}}e and {World {Health} Organization}").names)
      .toEqual(["{\\\"O}zt{\\\"u}rk, Ay{\\c{s}}e", "World {Health} Organization"]);
  });

  it("treats a final `others` as an incomplete list, not as a name", () => {
    expect(splitBibtexNames("Smith, A. and others")).toEqual({ names: ["Smith, A."], others: true });
    expect(splitBibtexNames("Others, Olivia")).toEqual({ names: ["Others, Olivia"], others: false });
  });
});

describe("biblatex default name truncation", () => {
  const names = (count: number) => ({ names: Array.from({ length: count }, (_, index) => `Author ${index + 1}`), others: false });

  it("keeps up to three names and shortens longer lists to the first name", () => {
    expect(truncateBibtexNames(names(3))).toEqual({ shown: ["Author 1", "Author 2", "Author 3"], truncated: false, total: 3 });
    expect(truncateBibtexNames(names(4))).toEqual({ shown: ["Author 1"], truncated: true, total: 4 });
  });

  it("always adds et al. after `and others`, whose total is unknown", () => {
    expect(truncateBibtexNames({ names: ["A", "B"], others: true })).toEqual({ shown: ["A", "B"], truncated: true, total: null });
    expect(truncateBibtexNames({ ...names(5), others: true })).toEqual({ shown: ["Author 1"], truncated: true, total: null });
  });
});
