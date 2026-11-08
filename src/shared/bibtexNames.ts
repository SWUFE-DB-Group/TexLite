import { bracedGroupEnd } from "./bibtexBraces.js";

export interface BibtexNameList {
  /** Names as written, in order, without the separating `and`. */
  names: string[];
  /** The list ended with `and others`: more names exist than are given. */
  others: boolean;
}

export interface TopLevelAndSeparator {
  /** Includes the whitespace that separates the preceding name from `and`. */
  from: number;
  /** Includes whitespace following `and`, when present. */
  to: number;
}

/**
 * Find BibTeX name-list separators: the word `and` (any case) after
 * whitespace, at brace depth 0, so `{Barnes and Noble}` and escaped TeX are
 * never split. A trailing `and` (a list still being typed) counts too, so it
 * never becomes part of a name. Shared by the editor's completion and
 * diagnostics and by author display.
 */
export function findTopLevelAndSeparators(text: string): TopLevelAndSeparator[] {
  const separators: TopLevelAndSeparator[] = [];
  let depth = 0;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (character === "\\") {
      index++;
      continue;
    }
    if (character === "{") {
      depth++;
      continue;
    }
    if (character === "}") {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth !== 0 || text.slice(index, index + 3).toLowerCase() !== "and") continue;
    const before = text[index - 1];
    const after = text[index + 3];
    if (!before || !/\s/.test(before) || (after !== undefined && !/\s/.test(after))) continue;
    let from = index;
    while (from > 0 && /\s/.test(text[from - 1])) from--;
    let to = index + 3;
    while (to < text.length && /\s/.test(text[to])) to++;
    separators.push({ from, to });
    index += 2;
  }
  return separators;
}

/**
 * Split a BibTeX name list (`author`, `editor`) into names at its top-level
 * `and` separators. A final `others` is BibTeX's marker for an incomplete
 * list, not a name. Names keep their original form: reordering or
 * abbreviating them would need BibTeX's full von/Jr. rules, and the source
 * text is never wrong.
 */
export function splitBibtexNames(value: string): BibtexNameList {
  const names: string[] = [];
  let start = 0;
  for (const separator of findTopLevelAndSeparators(value)) {
    names.push(value.slice(start, separator.from));
    start = separator.to;
  }
  names.push(value.slice(start));
  const cleaned = names.map(displayName).filter(Boolean);
  const others = cleaned.length > 1 && cleaned[cleaned.length - 1].toLowerCase() === "others";
  return { names: others ? cleaned.slice(0, -1) : cleaned, others };
}

/** Trim a name and drop braces that only protect the whole name, such as `{World Health Organization}`. */
function displayName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.startsWith("{") && bracedGroupEnd(trimmed, 0) === trimmed.length) return trimmed.slice(1, -1).trim();
  return trimmed;
}

export interface TruncatedBibtexNames {
  /** Names to display. */
  shown: string[];
  /** "et al." follows the shown names. */
  truncated: boolean;
  /** Number of names in the list; null when `and others` leaves it unknown. */
  total: number | null;
}

/**
 * biblatex's default name-list truncation (`maxnames=3`, `minnames=1`): a list
 * longer than `maxNames` shows only its first `minNames` names followed by
 * "et al.". A list ending in `and others` is already truncated, so it is
 * shortened the same way and always followed by "et al.".
 */
export function truncateBibtexNames(
  list: BibtexNameList,
  { maxNames = 3, minNames = 1 }: { maxNames?: number; minNames?: number } = {}
): TruncatedBibtexNames {
  const tooLong = list.names.length > maxNames;
  return {
    shown: tooLong ? list.names.slice(0, minNames) : list.names,
    truncated: tooLong || list.others,
    total: list.others ? null : list.names.length
  };
}
