import { bibtexVenue } from "../../shared/bibtexReferences";
import { parseBibtexDocument, type BibtexDocumentEntry } from "./entries";

/** Display metadata derived from the full BibTeX syntax tree. */
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
 */
export function bibtexEntrySummaries(source: string): Map<string, BibtexEntrySummary> {
  const summaries = new Map<string, BibtexEntrySummary>();
  for (const entry of parseBibtexDocument(source).entries) {
    if (!summaries.has(entry.key)) summaries.set(entry.key, summarize(entry));
  }
  return summaries;
}

export function bibtexEntrySummary(source: string, key: string): BibtexEntrySummary | null {
  return bibtexEntrySummaries(source).get(key) ?? null;
}

function summarize({ key, entryType, fields }: BibtexDocumentEntry): BibtexEntrySummary {
  const type = entryType.toLowerCase();
  return {
    key,
    entryType: type,
    title: fields.title ?? null,
    authors: fields.author ?? null,
    year: fields.year ?? null,
    venue: bibtexVenue(type, fields),
    doi: fields.doi ?? null,
    url: fields.url ?? null
  };
}
