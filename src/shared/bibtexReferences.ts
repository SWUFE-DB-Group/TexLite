/**
 * Lightweight BibTeX entry-key scanner for server-side completion and source
 * navigation. The browser editor uses the full Lezer grammar; this companion
 * deliberately only finds complete entry boundaries and keys, so server code
 * does not need to load a browser-oriented CodeMirror parser.
 */

import { isLatexCommentStart, skipLatexComment, skipLatexTrivia } from "./latexScanner.js";

interface BibtexBlock {
  from: number;
  to: number;
  contentFrom: number;
  contentTo: number;
}

export interface BibtexEntryKey {
  key: string;
  from: number;
  to: number;
  entryFrom: number;
  entryTo: number;
}

function readBibtexBlock(source: string, start: number): BibtexBlock | null {
  const opening = source[start];
  const closing = opening === "{" ? "}" : ")";
  if (opening !== "{" && opening !== "(") return null;

  // Braced and parenthesized BibTeX entries have different nesting rules. A
  // quote is ordinary content inside a braced entry, while a parenthesized
  // entry must protect its closing paren from braced and quoted values.
  let depth = 0;
  let braceDepth = 0;
  let quoted = false;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (character === "\\" && index + 1 < source.length) {
      index += 1;
      continue;
    }

    if (opening === "{") {
      // Comments belong to the entry body, not to its brace structure. Skip
      // them before counting braces so an unpaired } or { in a comment cannot
      // close or extend the entry. Quotes at the top level protect literal
      // percent signs inside quoted values.
      if (depth === 1 && !quoted && isLatexCommentStart(source, index)) {
        index = skipLatexComment(source, index);
        continue;
      }
      if (depth === 1 && character === "\"") quoted = !quoted;
      if (character === "{") {
        depth += 1;
        continue;
      }
      if (character !== "}") continue;
      depth -= 1;
      if (depth === 0) {
        return { from: start, to: index + 1, contentFrom: start + 1, contentTo: index };
      }
      continue;
    }

    if (quoted) {
      if (character === "{") braceDepth += 1;
      else if (character === "}" && braceDepth > 0) braceDepth -= 1;
      else if (character === "\"" && braceDepth === 0) quoted = false;
      continue;
    }
    if (braceDepth > 0) {
      if (character === "{") braceDepth += 1;
      else if (character === "}") braceDepth -= 1;
      continue;
    }
    if (depth === 1 && isLatexCommentStart(source, index)) {
      index = skipLatexComment(source, index);
      continue;
    }
    if (character === "{") {
      braceDepth = 1;
      continue;
    }
    if (character === "\"") {
      quoted = true;
      continue;
    }
    if (character === "(") {
      depth += 1;
      continue;
    }
    if (character !== closing) continue;
    depth -= 1;
    if (depth === 0) {
      return { from: start, to: index + 1, contentFrom: start + 1, contentTo: index };
    }
  }
  return null;
}

/**
 * Characters that end a key, as in the editor grammar's key token. A key must
 * then be followed, after whitespace and comments, by `,` or the end of the
 * entry: `@article{f(1), ...}` and `@article{title = {A}}` have no key.
 */
const keyTerminator = /[\s,{}()%]/;

function bibtexKeyRange(source: string, entry: BibtexBlock): { key: string; from: number; to: number } | null {
  const from = skipLatexTrivia(source, entry.contentFrom);
  if (from >= entry.contentTo) return null;
  let to = from;
  while (to < entry.contentTo && !keyTerminator.test(source[to])) to += 1;
  if (to <= from) return null;
  const separator = skipLatexTrivia(source, to);
  if (separator < entry.contentTo && source[separator] !== ",") return null;
  return { key: source.slice(from, to), from, to };
}

/**
 * Find ordinary BibTeX/BibLaTeX entry keys. `@string`, `@preamble`, and
 * `@comment` are intentionally skipped because their leading token is not a
 * citeable entry key.
 */
export function findBibtexEntryKeys(source: string): BibtexEntryKey[] {
  const entries: BibtexEntryKey[] = [];
  let index = 0;
  while (index < source.length) {
    // Percent signs are comments at top level. Once inside an entry a percent
    // may be part of a braced URL (for example `%20`), so the block reader
    // must receive the original source unchanged.
    if (isLatexCommentStart(source, index)) {
      index = skipLatexComment(source, index);
      continue;
    }
    if (source[index] !== "@") {
      index += 1;
      continue;
    }
    // An entry type is a letter followed by letters, digits, `_` or `-`,
    // matching the editor grammar (`@misc1`, `@article-v2`).
    let typeEnd = index + 1;
    if (!/[A-Za-z]/.test(source[typeEnd] ?? "")) {
      index += 1;
      continue;
    }
    while (typeEnd < source.length && /[A-Za-z0-9_-]/.test(source[typeEnd])) typeEnd += 1;
    let opening = typeEnd;
    while (opening < source.length && /\s/.test(source[opening])) opening += 1;
    const block = readBibtexBlock(source, opening);
    if (!block) {
      index = typeEnd;
      continue;
    }
    const type = source.slice(index + 1, typeEnd).toLowerCase();
    if (type !== "string" && type !== "preamble" && type !== "comment") {
      const key = bibtexKeyRange(source, block);
      if (key) entries.push({ ...key, entryFrom: index, entryTo: block.to });
    }
    // Do not scan @-looking text inside an already complete entry.
    index = block.to;
  }
  return entries;
}

/**
 * Where an entry was published. biblatex spells a journal `journaltitle`;
 * BibTeX spells it `journal`. Proceedings and collection parts prefer their
 * book title.
 */
export function bibtexVenue(entryType: string, fields: Readonly<Record<string, string>>): string | null {
  const journal = fields.journaltitle ?? fields.journal;
  const venue = /inproceedings|conference|incollection/.test(entryType.toLowerCase())
    ? fields.booktitle ?? journal
    : journal ?? fields.booktitle;
  return venue?.trim() || null;
}

/**
 * Publication year: BibTeX's `year`, or the year of biblatex's ISO 8601
 * `date` (`2021-05-03`, `2021/2022`). A `date` without a leading four-digit
 * year gives no year rather than a guess.
 */
export function bibtexYear(fields: Readonly<Record<string, string>>): string | null {
  const year = fields.year?.trim();
  if (year) return year;
  return /^\s*(-?\d{4})(?!\d)/.exec(fields.date ?? "")?.[1] ?? null;
}
