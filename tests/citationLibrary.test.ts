import { describe, expect, it } from "vitest";
import { parseBibEntries, parseSingleBibEntry } from "../src/server/citationLibrary.js";

describe("citation library BibTeX parser", () => {
  it("preserves complete entries and extracts common metadata", () => {
    const source = `prefix % @article{ignored-inline, title={No}}
% @article{ignored, title={No}}
@article{smith2025,
  author = {Smith, Ada and Jones, Bob},
  title = {A {Nested} title},
  year = "2025",
  note = {A comma, inside braces}
}
@inproceedings(foo2024,
  title={Conference paper},
  author={Foo},
  year={2024}
)
@string{venue = "Journal"}
`;
    const entries = parseBibEntries(source);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ citationKey: "smith2025", entryType: "article", title: "A {Nested} title", year: "2025" });
    expect(entries[0].bibtex).toContain("note = {A comma, inside braces}");
    expect(entries[1]).toMatchObject({ citationKey: "foo2024", entryType: "inproceedings", title: "Conference paper" });
  });

  it("accepts exactly one supported citation entry for library writes", () => {
    expect(parseSingleBibEntry("@article{one, title={One}}")?.citationKey).toBe("one");
    expect(parseSingleBibEntry("@comment{not a citation}")).toBeNull();
    expect(parseSingleBibEntry("@article{broken, title={Unclosed}")).toBeNull();
    expect(parseSingleBibEntry("@article{one, title={One}}\n@article{two, title={Two}}")).toBeNull();
  });

  it("rejects malformed fields and handles parentheses inside braced values", () => {
    expect(parseSingleBibEntry("@article{x, nonsense}")).toBeNull();
    expect(parseSingleBibEntry("@article{x, title=}")).toBeNull();
    expect(parseSingleBibEntry("@article(parenthesized, title={A) valid title}, year={2026})"))
      .toMatchObject({ citationKey: "parenthesized", title: "A) valid title", year: "2026" });
    expect(parseSingleBibEntry("@misc{encoded, url={https://example.test/a%20b}, title=\"A {Nested} title\"}"))
      .toMatchObject({ citationKey: "encoded", title: "A {Nested} title" });
  });
});
