import type { SyntaxNode } from "@lezer/common";
import { skipLatexTrivia } from "../../shared/latexScanner";
import { parser } from "./generatedParser.mjs";

export interface BibtexDocumentEntry {
  key: string;
  /** Entry type exactly as written, without the leading `@`. */
  entryType: string;
  /** Range of the whole entry in the source, from `@` through its closing delimiter. */
  from: number;
  to: number;
  /**
   * Lower-cased field names. Values have their outer delimiters removed and
   * `@string` macros expanded; a value that cannot be expanded (an undefined
   * macro) keeps its source text. A repeated field keeps its first value, as
   * BibTeX does.
   */
  fields: Record<string, string>;
}

export interface BibtexDocument {
  /** Citeable entries in source order. `@string`, `@preamble` and `@comment` are not entries. */
  entries: BibtexDocumentEntry[];
  /** The grammar had to recover from a syntax error somewhere in the source. */
  hasSyntaxErrors: boolean;
}

/** The month macros every standard BibTeX style defines. */
const predefinedMacros: ReadonlyArray<[string, string]> = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"
].map((month) => [month.slice(0, 3).toLowerCase(), month]);

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
  // BibTeX macro names are case-insensitive and must be defined before use,
  // so definitions are collected in source order as the walk reaches them.
  const macros = new Map(predefinedMacros);
  let hasSyntaxErrors = false;
  parser.parse(source).cursor().iterate((node: { name: string; type: { isError: boolean }; node: SyntaxNode }) => {
    if (node.type.isError) hasSyntaxErrors = true;
    if (node.name === "StringEntry") {
      defineMacro(source, node.node, macros);
      return;
    }
    if (node.name !== "Entry") return;
    const entry = readEntry(source, node.node, macros);
    if (entry) entries.push(entry);
  });
  return { entries, hasSyntaxErrors };
}

function defineMacro(source: string, entry: SyntaxNode, macros: Map<string, string>): void {
  const nameNode = entry.getChild("StringName");
  const valueNode = entry.getChild("Value");
  if (!nameNode || !valueNode) return;
  const value = expandValue(source, valueNode, macros);
  if (value !== null) macros.set(source.slice(nameNode.from, nameNode.to).toLowerCase(), value);
}

function readEntry(source: string, entry: SyntaxNode, macros: ReadonlyMap<string, string>): BibtexDocumentEntry | null {
  const keyNode = entry.getChild("EntryKey");
  if (!keyNode) return null;
  const key = source.slice(keyNode.from, keyNode.to);
  if (!key) return null;
  // A key is followed by a comma or the end of the entry. Otherwise the
  // grammar recovered from text that is not a key: `@article{title = {A}}`
  // has no key, and `@article{f(1), ...}` does not have the key `f`. The
  // server scanner applies the same rule, so both list the same keys.
  const next = source[skipLatexTrivia(source, keyNode.to)];
  if (next !== "," && next !== "}" && next !== ")") return null;

  const typeNode = entry.getChild("EntryType");
  const entryType = typeNode ? source.slice(typeNode.from, typeNode.to).replace(/^@/, "").trim() : "";
  const fields: Record<string, string> = {};
  const seen = new Set<string>();
  for (const field of entry.getChildren("Field")) {
    const nameNode = field.getChild("FieldName");
    const valueNode = field.getChild("Value");
    if (!nameNode || !valueNode) continue;
    const name = source.slice(nameNode.from, nameNode.to).toLowerCase();
    // BibTeX ignores a repeated field (with a warning, which the editor's
    // diagnostics also show), so the first occurrence is the one that prints.
    if (seen.has(name)) continue;
    seen.add(name);
    const value = fieldValue(source, valueNode, macros);
    if (value) fields[name] = value;
  }
  return { key, entryType, from: entry.from, to: entry.to, fields };
}

function fieldValue(source: string, valueNode: SyntaxNode, macros: ReadonlyMap<string, string>): string | null {
  // An undefined macro cannot be expanded; show the expression as written
  // rather than guessing what it stands for.
  const value = expandValue(source, valueNode, macros) ?? source.slice(valueNode.from, valueNode.to);
  return value.replace(/\s+/g, " ").trim() || null;
}

/** The text of a value with its delimiters removed and macros expanded, or null when that is not possible. */
function expandValue(source: string, valueNode: SyntaxNode, macros: ReadonlyMap<string, string>): string | null {
  let text = "";
  for (let child = valueNode.firstChild; child; child = child.nextSibling) {
    if (child.name === "Concat") continue;
    const atom = child.name === "ValueAtom" ? child.firstChild : null;
    if (!atom) return null;
    if (atom.name === "BracedValue" || atom.name === "QuotedValue") {
      const closing = atom.name === "BracedValue" ? "}" : "\"";
      if (atom.to - atom.from < 2 || source[atom.to - 1] !== closing) return null;
      text += source.slice(atom.from + 1, atom.to - 1);
    } else if (atom.name === "Number") {
      text += source.slice(atom.from, atom.to);
    } else if (atom.name === "StringRef") {
      const expansion = macros.get(source.slice(atom.from, atom.to).toLowerCase());
      if (expansion === undefined) return null;
      text += expansion;
    } else {
      return null;
    }
  }
  return text;
}

/** Fields that describe the parent entry itself and are never inherited. */
const uninheritedFields = new Set([
  "ids", "crossref", "xref", "xdata", "entryset", "entrysubtype", "execute", "label", "options",
  "presort", "related", "relatedoptions", "relatedstring", "relatedtype", "shorthand",
  "shorthandintro", "sortkey", "title", "subtitle", "titleaddon", "shorttitle", "sorttitle",
  "indextitle", "indexsorttitle"
]);

/** Parent types whose title is the title of the book that contains the child. */
const bookParents = new Set([
  "book", "mvbook", "collection", "mvcollection", "proceedings", "mvproceedings", "reference", "mvreference"
]);

/**
 * Entries with the fields they inherit from a `crossref` parent in the same
 * document, following biblatex's default inheritance: the child keeps every
 * field it has, takes the parent's other fields, and a parent book's title
 * becomes the child's `booktitle` (a periodical's becomes `journaltitle`).
 * One level is resolved; a parent outside the document contributes nothing.
 */
export function withCrossrefFields(entries: readonly BibtexDocumentEntry[]): BibtexDocumentEntry[] {
  const byKey = new Map<string, BibtexDocumentEntry>();
  for (const entry of entries) {
    const key = entry.key.toLowerCase();
    if (!byKey.has(key)) byKey.set(key, entry);
  }
  return entries.map((entry) => {
    const parent = entry.fields.crossref ? byKey.get(entry.fields.crossref.toLowerCase()) : undefined;
    if (!parent || parent === entry) return entry;
    const inherited: Record<string, string> = {};
    for (const [name, value] of Object.entries(parent.fields)) {
      if (!uninheritedFields.has(name)) inherited[name] = value;
    }
    const parentType = parent.entryType.toLowerCase();
    if (parent.fields.title) {
      if (bookParents.has(parentType)) inherited.booktitle ??= parent.fields.title;
      else if (parentType === "periodical") inherited.journaltitle ??= parent.fields.title;
    }
    return { ...entry, fields: { ...inherited, ...entry.fields } };
  });
}
