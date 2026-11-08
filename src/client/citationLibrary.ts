import { bibtexVenue, bibtexYear } from "../shared/bibtexReferences";
import { parseBibtexDocument, withCrossrefFields, type BibtexDocumentEntry } from "./bibtex/entries";
import { isBibtexTooLarge } from "./bibtexLimits";

export { citationBibtexLimitLabel, isBibtexTooLarge } from "./bibtexLimits";

/**
 * Browser-side BibTeX validation for the citation library.
 *
 * The editor's Lezer grammar decides what is an entry, where it starts and
 * ends, and whether the source is valid, so the library agrees with what the
 * editor highlights and reports as a syntax error. Validating in the browser
 * rejects malformed input before a request reaches the server, which keeps a
 * second BibTeX parser out of the server.
 */

export interface ParsedCitationEntry {
  citationKey: string;
  entryType: string;
  bibtex: string;
  title: string | null;
  authors: string | null;
  year: string | null;
  venue: string | null;
}

export type BibtexParseStatus = "ok" | "empty" | "too-large" | "invalid";

export interface BibtexParseResult {
  status: BibtexParseStatus;
  entries: ParsedCitationEntry[];
}

function citationEntry(source: string, entry: BibtexDocumentEntry): ParsedCitationEntry {
  return {
    citationKey: entry.key,
    entryType: entry.entryType,
    bibtex: source.slice(entry.from, entry.to),
    title: entry.fields.title ?? null,
    authors: entry.fields.author ?? null,
    year: bibtexYear(entry.fields),
    venue: bibtexVenue(entry.entryType, entry.fields)
  };
}

/**
 * Parse a BibTeX document while preserving the reason an empty result was
 * returned. Callers that make safety decisions (for example duplicate-key
 * checks) must not treat an oversized document as an empty one.
 */
export function parseBibEntriesResult(source: string, maxBytes: number): BibtexParseResult {
  if (!source.trim()) return { status: "empty", entries: [] };
  if (isBibtexTooLarge(source, maxBytes)) return { status: "too-large", entries: [] };
  const document = parseBibtexDocument(source);
  if (document.hasSyntaxErrors) return { status: "invalid", entries: [] };
  if (!document.entries.length) return { status: "empty", entries: [] };
  // A parent in the same file fills the child's venue and year; the saved
  // BibTeX stays exactly as written.
  return { status: "ok", entries: withCrossrefFields(document.entries).map((entry) => citationEntry(source, entry)) };
}

/**
 * Venue and year shown on a citation card. Rows saved before the venue column
 * existed, or before biblatex's `journaltitle` and `date` were read, carry
 * null, so derive them from their BibTeX instead of hiding them until the
 * entry is saved again. Callers should memoize per entry; only rows missing a
 * value pay for a parse.
 */
export function citationDisplayMetadata(
  entry: Pick<ParsedCitationEntry, "bibtex" | "venue" | "year">
): { venue: string | null; year: string | null } {
  if (entry.venue && entry.year) return { venue: entry.venue, year: entry.year };
  const [parsed] = parseBibtexDocument(entry.bibtex).entries;
  return {
    venue: entry.venue || (parsed ? bibtexVenue(parsed.entryType, parsed.fields) : null),
    year: entry.year || (parsed ? bibtexYear(parsed.fields) : null)
  };
}

/** Accept text that is exactly one citeable entry, with nothing before or after it. */
export function parseSingleBibEntry(source: string, maxBytes: number): ParsedCitationEntry | null {
  const bibtex = source.trim();
  if (!bibtex || isBibtexTooLarge(bibtex, maxBytes)) return null;
  const document = parseBibtexDocument(bibtex);
  const [entry] = document.entries;
  if (document.hasSyntaxErrors || document.entries.length !== 1 || entry.from !== 0 || entry.to !== bibtex.length) return null;
  return citationEntry(bibtex, entry);
}
