import { describe, expect, it, vi } from "vitest";
import { parseCitationFolderFile } from "../src/client/citationFolderImport";
import * as citationLibrary from "../src/client/citationLibrary";
import { CITATION_FOLDER_FORMAT, MAX_CITATION_FOLDER_BYTES, MAX_CITATION_FOLDER_ENTRIES, MAX_CITATION_NOTES_BYTES } from "../src/shared/citationTransfer";

const bibtex = "@article{paper, title={A paper}, author={Ada}, year={2026}}";
const bundle = { format: CITATION_FOLDER_FORMAT, version: 1, entries: [{ bibtex, notes: "**Notes**" }] };
const parse = (source: string, filename = "reading.json", limit = 512 * 1024) => parseCitationFolderFile(source, filename, limit);

describe("citation import normalization", () => {
  it("parses all BibTeX entries and preserves source text without importing tags, notes or a folder name", () => {
    const book = "@book{book, title={{Book}}, keywords={math}, year={2025}}";
    const result = parse(`\uFEFF% Reading list\n${bibtex}\n${book}`, "  阅读主题.BIB");
    expect(result).toMatchObject({ entries: [
      { citationKey: "paper", bibtex, title: "A paper", authors: "Ada", year: "2026", notes: "" },
      { citationKey: "book", bibtex: book, notes: "" }
    ] });
    expect(result).not.toHaveProperty("name");
  });

  it("preserves JSON notes but ignores embedded folder names, tag fields, IDs and untrusted metadata", () => {
    const result = parse(JSON.stringify({ ...bundle, name: "Ignore this embedded folder name", tags: ["ignored"], entries: [{ ...bundle.entries[0],
      tags: ["ignored"], tagIds: ["foreign"], collectionIds: ["foreign"], id: "foreign", title: "Not the real title" }] }));
    expect(result).toEqual({ format: CITATION_FOLDER_FORMAT, version: 1, entries: [
      { bibtex, citationKey: "paper", entryType: "article", title: "A paper", authors: "Ada", year: "2026", notes: "**Notes**" }
    ] });
    expect(parse(JSON.stringify({ ...bundle, entries: [] })).entries).toEqual([]);
  });

  it("rejects invalid formats, empty BibTeX and oversized individual entries before submission", () => {
    for (const [source, filename] of [["not json", "bad.json"], [JSON.stringify({ ...bundle, version: 2 }), "bad.json"],
      ["% no entries", "empty.bib"], ["@article{broken", "bad.bib"], [bibtex, "file.txt"]]) {
      expect(() => parse(source, filename)).toThrow("citationFolders.importInvalid");
    }
    expect(() => parse(bibtex, "file.bib", 10)).toThrow("citationFolders.importInvalid");
    expect(() => parse(JSON.stringify(bundle), "file.json", 10)).toThrow("citationFolders.importInvalid");
  });

  it("accepts 500 entries and rejects 501 for both file formats", () => {
    const entries = Array.from({ length: 500 }, (_, index) => ({ bibtex: `@misc{ref${index}, title={Reference ${index}}}`, notes: "" }));
    expect(parse(JSON.stringify({ ...bundle, entries })).entries).toHaveLength(500);
    expect(parse(entries.map((entry) => entry.bibtex).join("\n"), "reading.bib").entries).toHaveLength(500);
    entries.push({ bibtex, notes: "" });
    expect(() => parse(JSON.stringify({ ...bundle, entries }))).toThrow("citationFolders.transferTooLarge");
    expect(() => parse(entries.map((entry) => entry.bibtex).join("\n"), "reading.bib")).toThrow("citationFolders.transferTooLarge");
  });

  it("enforces file, entry-count, UTF-8 notes and normalized request limits", () => {
    expect(() => parse("x".repeat(MAX_CITATION_FOLDER_BYTES + 1))).toThrow("citationFolders.transferTooLarge");
    expect(() => parse(JSON.stringify({ ...bundle, entries: Array(MAX_CITATION_FOLDER_ENTRIES + 1).fill(bundle.entries[0]) })))
      .toThrow("citationFolders.transferTooLarge");
    expect(() => parse(JSON.stringify({ ...bundle, entries: [{ bibtex, notes: "中".repeat(Math.ceil(MAX_CITATION_NOTES_BYTES / 3)) }] })))
      .toThrow("citationNotes.tooLarge");
    // Test expanded payload accounting without running the parser on a huge title.
    const expanded = vi.spyOn(citationLibrary, "parseBibEntriesResult").mockReturnValue({ status: "ok", entries: [{
      citationKey: "paper", entryType: "article", bibtex, title: "x".repeat(MAX_CITATION_FOLDER_BYTES), authors: null, year: null
    }] });
    try { expect(() => parse(bibtex, "file.bib")).toThrow("citationFolders.transferTooLarge"); }
    finally { expanded.mockRestore(); }
  });
});
