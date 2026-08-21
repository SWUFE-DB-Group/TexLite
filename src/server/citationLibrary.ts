/**
 * Small, dependency-free BibTeX entry parser used by the personal citation
 * library. It deliberately preserves the original entry text so importing a
 * reference never rewrites formatting chosen by the library owner.
 */

export interface ParsedCitationEntry {
  citationKey: string;
  entryType: string;
  bibtex: string;
  title: string | null;
  authors: string | null;
  year: string | null;
}

const ignoredEntryTypes = new Set(["comment", "string", "preamble"]);
export const MAX_CITATION_BIBTEX_BYTES = 512 * 1024;

export function parseBibEntries(source: string): ParsedCitationEntry[] {
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
    const raw = source.slice(at, closing + 1).trim();
    const parsed = parseSingleBibEntry(raw);
    if (parsed && !ignoredEntryTypes.has(parsed.entryType.toLowerCase())) entries.push(parsed);
    searchFrom = closing + 1;
  }
  return entries;
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

export function parseSingleBibEntry(source: string): ParsedCitationEntry | null {
  const bibtex = source.trim();
  if (!bibtex || new TextEncoder().encode(bibtex).length > MAX_CITATION_BIBTEX_BYTES) return null;
  const header = bibtex.match(/^@([A-Za-z][A-Za-z0-9_-]*)\s*([\{\(])\s*([^,\s\}\)]+)\s*,/s);
  if (!header) return null;
  const opening = bibtex.indexOf(header[2], header.index ?? 0);
  const closing = matchingDelimiter(bibtex, opening, header[2] === "{" ? "}" : ")");
  if (closing !== bibtex.length - 1) return null;
  const entryType = header[1];
  if (ignoredEntryTypes.has(entryType.toLowerCase())) return null;
  const fields = parseFields(bibtex.slice(header[0].length, -1));
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

function parseFields(body: string): Record<string, string> | null {
  const fields: Record<string, string> = {};
  for (const segment of splitTopLevel(body, ",")) {
    if (!segment.trim()) continue;
    const match = segment.match(/^\s*([A-Za-z][A-Za-z0-9_-]*)\s*=\s*([\s\S]*)$/);
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
