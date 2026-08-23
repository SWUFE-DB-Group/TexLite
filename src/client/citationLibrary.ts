import { tidy } from "bibtex-tidy";

/**
 * Browser-side BibTeX validation and formatting.
 *
 * bibtex-tidy owns the syntax/parser work. The small delimiter scanner below
 * only locates the original entry text and extracts display metadata; it does
 * not decide whether an entry is valid. Keeping validation in the browser
 * means malformed input is rejected before a request reaches the server and
 * avoids maintaining a second parser implementation on the server.
 */

export interface ParsedCitationEntry {
  citationKey: string;
  entryType: string;
  bibtex: string;
  title: string | null;
  authors: string | null;
  year: string | null;
}

export type BibtexParseStatus = "ok" | "empty" | "too-large" | "invalid";

export interface BibtexParseResult {
  status: BibtexParseStatus;
  entries: ParsedCitationEntry[];
}

export class BibtexFormatError extends Error {
  constructor(readonly kind: "too-large" | "invalid") {
    super(kind === "too-large" ? "BibTeX input is too large to format" : "BibTeX input is invalid");
    this.name = "BibtexFormatError";
  }
}

export const MAX_CITATION_BIBTEX_BYTES = 512 * 1024;

const ignoredEntryTypes = new Set(["comment", "string", "preamble"]);
const tidyOptions = { lowercase: false, removeDuplicateFields: false } as const;

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function isBibtexTooLarge(source: string): boolean {
  return byteLength(source) > MAX_CITATION_BIBTEX_BYTES;
}

function tidyBibtex(source: string): { bibtex: string; count: number } | null {
  if (!source.trim() || isBibtexTooLarge(source)) return null;
  try {
    const result = tidy(source, tidyOptions);
    return { bibtex: result.bibtex, count: result.count };
  } catch {
    return null;
  }
}

/** Format a BibTeX document without changing its field names or values. */
export function formatBibtex(source: string): string {
  if (!source.trim()) return source;
  if (isBibtexTooLarge(source)) throw new BibtexFormatError("too-large");
  const result = tidyBibtex(source);
  if (!result) throw new BibtexFormatError("invalid");
  return result.bibtex;
}

export function parseBibEntries(source: string): ParsedCitationEntry[] {
  return parseBibEntriesResult(source).entries;
}

/**
 * Parse a BibTeX document while preserving the reason an empty result was
 * returned. Callers that make safety decisions (for example duplicate-key
 * checks) must not treat an oversized document as an empty one.
 */
export function parseBibEntriesResult(source: string): BibtexParseResult {
  if (!source.trim()) return { status: "empty", entries: [] };
  if (isBibtexTooLarge(source)) return { status: "too-large", entries: [] };
  const tidyResult = tidyBibtex(source);
  if (!tidyResult) return { status: "invalid", entries: [] };
  if (tidyResult.count === 0) return { status: "empty", entries: [] };
  const entries: ParsedCitationEntry[] = [];
  let searchFrom = 0;
  while (searchFrom < source.length) {
    const at = source.indexOf("@", searchFrom);
    if (at < 0) break;
    searchFrom = at + 1;
    const lineStart = source.lastIndexOf("\n", at - 1) + 1;
    if (isCommented(source, lineStart, at)) continue;
    const header = source.slice(at).match(/^@([A-Za-z][A-Za-z0-9_-]*)\s*([\{\(])/);
    if (!header || header.index === undefined) continue;
    const opening = at + header[0].length - 1;
    const closing = matchingDelimiter(source, opening, header[2] === "{" ? "}" : ")");
    if (closing < 0) continue;
    const parsed = parseRawBibEntry(source.slice(at, closing + 1));
    if (parsed) entries.push(parsed);
    searchFrom = closing + 1;
  }
  return { status: "ok", entries };
}

export function parseSingleBibEntry(source: string): ParsedCitationEntry | null {
  const bibtex = source.trim();
  const tidyResult = tidyBibtex(bibtex);
  if (!tidyResult || tidyResult.count !== 1) return null;
  return parseRawBibEntry(bibtex);
}

/** Return the publication venue used by the citation card, when available. */
export function citationVenue(entry: Pick<ParsedCitationEntry, "bibtex">): string | null {
  const header = entry.bibtex.match(/^@([A-Za-z][A-Za-z0-9_-]*)\s*([\{\(])\s*[^,\s\}\)]+\s*,/s);
  if (!header || header.index === undefined) return null;
  const opening = entry.bibtex.indexOf(header[2], header.index);
  const closing = matchingDelimiter(entry.bibtex, opening, header[2] === "{" ? "}" : ")");
  if (closing < 0) return null;
  const fields = extractFields(entry.bibtex.slice(header[0].length, -1));
  if (!fields) return null;
  const entryType = header[1].toLowerCase();
  const venue = /inproceedings|conference|incollection/.test(entryType)
    ? fields.booktitle ?? fields.journal
    : fields.journal ?? fields.booktitle;
  return venue?.trim() || null;
}

function parseRawBibEntry(bibtex: string): ParsedCitationEntry | null {
  const header = bibtex.match(/^@([A-Za-z][A-Za-z0-9_-]*)\s*([\{\(])\s*([^,\s\}\)]+)\s*,/s);
  if (!header) return null;
  const opening = bibtex.indexOf(header[2], header.index ?? 0);
  const closing = matchingDelimiter(bibtex, opening, header[2] === "{" ? "}" : ")");
  if (closing !== bibtex.length - 1) return null;
  const entryType = header[1];
  if (ignoredEntryTypes.has(entryType.toLowerCase())) return null;
  const fields = extractFields(bibtex.slice(header[0].length, -1));
  if (!fields) return null;
  return {
    citationKey: header[3],
    entryType,
    bibtex,
    title: fields.title ?? null,
    authors: fields.author ?? null,
    year: fields.year ?? null
  };
}

function isCommented(source: string, lineStart: number, end: number): boolean {
  let escaped = false;
  for (let index = lineStart; index < end; index += 1) {
    const character = source[index];
    if (character === "%" && !escaped) return true;
    if (character === "\\") escaped = !escaped;
    else escaped = false;
  }
  return false;
}

function matchingDelimiter(source: string, opening: number, closingCharacter: "}" | ")"): number {
  let outerDepth = 0;
  let braceDepth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = opening; index < source.length; index += 1) {
    const character = source[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (closingCharacter === "}") {
      if (character === '"' && outerDepth === 1) quoted = !quoted;
      if (character === "{") outerDepth += 1;
      else if (character === "}" && --outerDepth === 0) return index;
      continue;
    }
    if (character === "{" && !quoted) {
      braceDepth += 1;
      continue;
    }
    if (character === "}" && !quoted && braceDepth > 0) {
      braceDepth -= 1;
      continue;
    }
    if (braceDepth > 0) continue;
    if (character === '"') {
      quoted = !quoted;
      continue;
    }
    if (quoted) continue;
    if (character === "(") outerDepth += 1;
    else if (character === ")" && --outerDepth === 0) return index;
  }
  return -1;
}

function extractFields(body: string): Record<string, string> | null {
  const fields: Record<string, string> = {};
  for (const segment of splitTopLevel(body, ",")) {
    if (!segment.trim()) continue;
    const withoutLeadingComments = segment.replace(/(^|[\r\n])\s*%[^\r\n]*/g, "$1").trim();
    if (!withoutLeadingComments) continue;
    const match = withoutLeadingComments.match(/^\s*([A-Za-z][A-Za-z0-9_-]*)\s*=\s*([\s\S]*)$/);
    if (!match || !match[2].trim()) return null;
    const value = cleanFieldValue(match[2]);
    if (value) fields[match[1].toLowerCase()] = value;
  }
  return fields;
}

function splitTopLevel(source: string, separator: string): string[] {
  const result: string[] = [];
  let start = 0;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character === '"') {
      quoted = !quoted;
      continue;
    }
    if (quoted) continue;
    if (character === "{") depth += 1;
    else if (character === "}") depth = Math.max(0, depth - 1);
    else if (character === separator && depth === 0) {
      result.push(source.slice(start, index));
      start = index + 1;
    }
  }
  result.push(source.slice(start));
  return result;
}

function cleanFieldValue(value: string): string {
  let result = value.trim();
  if ((result.startsWith("{") && result.endsWith("}")) || (result.startsWith('"') && result.endsWith('"'))) {
    result = result.slice(1, -1);
  }
  return result.replace(/\s+/g, " ").trim();
}
