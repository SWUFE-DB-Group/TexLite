import type { SyntaxNode } from "@lezer/common";
import { cleanBibtexFieldValue } from "../../shared/bibtexReferences";
import { parser } from "./generatedParser.mjs";

export interface BibtexDocumentEntry {
  key: string;
  /** Entry type exactly as written, without the leading `@`. */
  entryType: string;
  /** Range of the whole entry in the source, from `@` through its closing delimiter. */
  from: number;
  to: number;
  /** Lower-cased field names; a repeated field keeps its last value. */
  fields: Record<string, string>;
}

export interface BibtexDocument {
  /** Citeable entries in source order. `@string`, `@preamble` and `@comment` are not entries. */
  entries: BibtexDocumentEntry[];
  /** The grammar had to recover from a syntax error somewhere in the source. */
  hasSyntaxErrors: boolean;
}

/**
 * Read every entry of a BibTeX source with the editor's Lezer grammar.
 *
 * This is the single definition of what counts as an entry, where it starts
 * and ends, and what its fields are. Hover previews and the citation library
 * both build on it, so neither can disagree with what the editor highlights
 * or reports as a syntax error. Entries recovered from a syntax error are still
 * listed; callers that must not accept them check `hasSyntaxErrors`.
 */
export function parseBibtexDocument(source: string): BibtexDocument {
  const entries: BibtexDocumentEntry[] = [];
  let hasSyntaxErrors = false;
  parser.parse(source).cursor().iterate((node: { name: string; from: number; to: number; type: { isError: boolean }; node: SyntaxNode }) => {
    if (node.type.isError) hasSyntaxErrors = true;
    if (node.name !== "Entry") return;
    const entry = readEntry(source, node.node);
    if (entry) entries.push(entry);
  });
  return { entries, hasSyntaxErrors };
}

const keyFollowedByEquals = /\s*=/y;

function readEntry(source: string, entry: SyntaxNode): BibtexDocumentEntry | null {
  const keyNode = entry.getChild("EntryKey");
  if (!keyNode) return null;
  const key = source.slice(keyNode.from, keyNode.to);
  if (!key) return null;
  // `@article{title = {A}}` has no key: the grammar reads the first field name
  // as one and then fails at `=`. Like the server scanner, require that a key
  // is not followed by `=`, so a field name never becomes a citeable key.
  keyFollowedByEquals.lastIndex = keyNode.to;
  if (keyFollowedByEquals.test(source)) return null;

  const typeNode = entry.getChild("EntryType");
  const entryType = typeNode ? source.slice(typeNode.from, typeNode.to).replace(/^@/, "").trim() : "";
  const fields: Record<string, string> = {};
  for (const field of entry.getChildren("Field")) {
    const nameNode = field.getChild("FieldName");
    const valueNode = field.getChild("Value");
    if (!nameNode || !valueNode) continue;
    const value = fieldValue(source, valueNode);
    if (value) fields[source.slice(nameNode.from, nameNode.to).toLowerCase()] = value;
  }
  return { key, entryType, from: entry.from, to: entry.to, fields };
}

function fieldValue(source: string, valueNode: SyntaxNode): string | null {
  // Concatenated macro expressions are not a single literal; keep their
  // source text for display rather than guessing how @string expands.
  if (valueNode.getChild("Concat")) {
    return source.slice(valueNode.from, valueNode.to).replace(/\s+/g, " ").trim() || null;
  }
  return cleanBibtexFieldValue(source.slice(valueNode.from, valueNode.to)) || null;
}
