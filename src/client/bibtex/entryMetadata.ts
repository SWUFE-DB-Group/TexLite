import type { SyntaxNode } from "@lezer/common";
import { bibtexVenue, cleanBibtexFieldValue } from "../../shared/bibtexReferences";
import { parser } from "./generatedParser.mjs";

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
 * Parse every entry in one BibTeX source with the editor's Lezer grammar.
 * Callers can cache the resulting map per file instead of reparsing the source
 * for every citation key.
 */
export function bibtexEntrySummaries(source: string): Map<string, BibtexEntrySummary> {
  const entries = new Map<string, BibtexEntrySummary>();
  parser.parse(source).cursor().iterate((node: { name: string; node: SyntaxNode }) => {
    if (node.name !== "Entry") return;
    const entry = node.node;
    const keyNode = entry.getChild("EntryKey");
    if (!keyNode) return false;
    const key = source.slice(keyNode.from, keyNode.to);
    if (!key || entries.has(key)) return false;

    const typeNode = entry.getChild("EntryType");
    const entryType = typeNode
      ? source.slice(typeNode.from, typeNode.to).replace(/^@/, "").trim().toLowerCase()
      : "";
    const fields: Record<string, string> = {};
    for (const field of entry.getChildren("Field")) {
      const nameNode = field.getChild("FieldName");
      const valueNode = field.getChild("Value");
      if (!nameNode || !valueNode) continue;
      const name = source.slice(nameNode.from, nameNode.to).toLowerCase();
      const value = fieldValue(source, valueNode);
      if (value) fields[name] = value;
    }

    const text = (value: string | undefined): string | null => value?.trim() || null;
    entries.set(key, {
      key,
      entryType,
      title: text(fields.title),
      authors: text(fields.author),
      year: text(fields.year),
      venue: bibtexVenue(entryType, fields),
      doi: text(fields.doi),
      url: text(fields.url)
    });
    return false;
  });
  return entries;
}

export function bibtexEntrySummary(source: string, key: string): BibtexEntrySummary | null {
  return bibtexEntrySummaries(source).get(key) ?? null;
}

function fieldValue(source: string, valueNode: SyntaxNode): string | null {
  // Concatenated macro expressions are not a single literal; keep their
  // source text for display rather than guessing how @string expands.
  if (valueNode.getChild("Concat")) {
    return source.slice(valueNode.from, valueNode.to).replace(/\s+/g, " ").trim() || null;
  }
  return cleanBibtexFieldValue(source.slice(valueNode.from, valueNode.to)) || null;
}
