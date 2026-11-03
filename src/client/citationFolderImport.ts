import { CITATION_FOLDER_FORMAT, CITATION_FOLDER_VERSION, MAX_CITATION_FOLDER_BYTES,
  MAX_CITATION_FOLDER_ENTRIES, MAX_CITATION_NOTES_BYTES, type CitationFolderBundle } from "../shared/citationTransfer";
import { parseBibEntriesResult, parseSingleBibEntry } from "./citationLibrary";

export class CitationFolderImportError extends Error {
  constructor(readonly key: "citationFolders.importInvalid" | "citationFolders.transferTooLarge" | "citationNotes.tooLarge") {
    super(key);
  }
}

/** Normalize both formats to the same import payload. Tags and internal IDs never travel. */
export function parseCitationFolderFile(source: string, filename: string, maxBibtexBytes: number): CitationFolderBundle {
  const bytes = (value: string) => new TextEncoder().encode(value).byteLength;
  const fail = () => { throw new CitationFolderImportError("citationFolders.importInvalid"); };
  if (bytes(source) > MAX_CITATION_FOLDER_BYTES) throw new CitationFolderImportError("citationFolders.transferTooLarge");
  source = source.replace(/^\uFEFF/, "");
  let entries: CitationFolderBundle["entries"];
  if (/\.bib$/i.test(filename)) {
    const result = parseBibEntriesResult(source, MAX_CITATION_FOLDER_BYTES);
    if (result.status !== "ok" || !result.entries.length) return fail();
    if (result.entries.length > MAX_CITATION_FOLDER_ENTRIES) throw new CitationFolderImportError("citationFolders.transferTooLarge");
    entries = result.entries.map((entry) => {
      if (bytes(entry.bibtex) > maxBibtexBytes) return fail();
      return { ...entry, notes: "" };
    });
  } else if (/\.json$/i.test(filename)) {
    let data: Partial<CitationFolderBundle> | null;
    try { data = JSON.parse(source); } catch { return fail(); }
    if (!data || data.format !== CITATION_FOLDER_FORMAT || data.version !== CITATION_FOLDER_VERSION
      || !Array.isArray(data.entries)) return fail();
    if (data.entries.length > MAX_CITATION_FOLDER_ENTRIES) throw new CitationFolderImportError("citationFolders.transferTooLarge");
    entries = data.entries.map((entry) => {
      if (!entry || typeof entry.bibtex !== "string" || typeof entry.notes !== "string") return fail();
      if (bytes(entry.notes) > MAX_CITATION_NOTES_BYTES) throw new CitationFolderImportError("citationNotes.tooLarge");
      const parsed = parseSingleBibEntry(entry.bibtex, maxBibtexBytes);
      if (!parsed) return fail();
      return { ...parsed, notes: entry.notes };
    });
  } else return fail();
  const bundle: CitationFolderBundle = { format: CITATION_FOLDER_FORMAT, version: CITATION_FOLDER_VERSION, entries };
  // Escaping and metadata can make the normalized request larger than the file.
  if (bytes(JSON.stringify(bundle)) > MAX_CITATION_FOLDER_BYTES) {
    throw new CitationFolderImportError("citationFolders.transferTooLarge");
  }
  return bundle;
}
