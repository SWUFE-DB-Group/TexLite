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
      if (character === "\"") quoted = false;
      continue;
    }
    if (braceDepth > 0) {
      if (character === "{") braceDepth += 1;
      else if (character === "}") braceDepth -= 1;
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

function bibtexKeyRange(source: string, entry: BibtexBlock): { key: string; from: number; to: number } | null {
  let from = entry.contentFrom;
  while (from < entry.contentTo && /\s/.test(source[from])) from += 1;
  if (from >= entry.contentTo) return null;
  let to = from;
  while (to < entry.contentTo && source[to] !== "," && !/\s/.test(source[to])) to += 1;
  let trimmedTo = to;
  while (trimmedTo > from && /\s/.test(source[trimmedTo - 1])) trimmedTo -= 1;
  if (trimmedTo <= from) return null;
  const separator = skipLatexTrivia(source, to);
  if (separator < entry.contentTo && source[separator] !== ",") return null;
  return { key: source.slice(from, trimmedTo), from, to: trimmedTo };
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
    let typeEnd = index + 1;
    while (typeEnd < source.length && /[A-Za-z]/.test(source[typeEnd])) typeEnd += 1;
    if (typeEnd === index + 1) {
      index += 1;
      continue;
    }
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
