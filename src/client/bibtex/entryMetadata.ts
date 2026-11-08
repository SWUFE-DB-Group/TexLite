import { bibtexVenue, bibtexYear } from "../../shared/bibtexReferences";
import { parseBibtexDocument, withCrossrefFields, type BibtexDocumentEntry } from "./entries";

/**
 * Display metadata derived from the full BibTeX syntax tree. Values are TeX
 * as written (macros expanded); convert with `bibtexDisplayText` to show them.
 */
export interface BibtexEntrySummary {
  key: string;
  entryType: string;
  title: string | null;
  authors: string | null;
  year: string | null;
  venue: string | null;
  doi: string | null;
  url: string | null;
}

/**
 * Summarize every entry in one BibTeX source. Callers can cache the resulting
 * map per file instead of reparsing the source for every citation key. A
 * repeated key keeps its first entry, matching how navigation resolves it.
 * Fields missing from an entry are taken from its `crossref` parent when the
 * parent is in the same file.
 */
export function bibtexEntrySummaries(source: string): Map<string, BibtexEntrySummary> {
  const summaries = new Map<string, BibtexEntrySummary>();
  for (const entry of withCrossrefFields(parseBibtexDocument(source).entries)) {
    if (!summaries.has(entry.key)) summaries.set(entry.key, summarize(entry));
  }
  return summaries;
}

function summarize({ key, entryType, fields }: BibtexDocumentEntry): BibtexEntrySummary {
  const type = entryType.toLowerCase();
  return {
    key,
    entryType: type,
    title: fields.title ?? null,
    authors: fields.author ?? null,
    year: bibtexYear(fields),
    venue: bibtexVenue(type, fields),
    doi: fields.doi ?? null,
    url: fields.url ?? null
  };
}
