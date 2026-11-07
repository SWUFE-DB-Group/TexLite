export interface BibtexNameList {
  /** Names as written, in order, without the separating `and`. */
  names: string[];
  /** The list ended with `and others`: more names exist than are given. */
  others: boolean;
}

/**
 * Split a BibTeX name list (`author`, `editor`) into names.
 *
 * Names are separated by the word `and` (any case) surrounded by whitespace,
 * and only at brace depth 0, so `{Barnes and Noble}` stays one corporate name.
 * A final `others` is BibTeX's marker for an incomplete list, not a name.
 * Names keep their original form: reordering or abbreviating them would need
 * BibTeX's full von/Jr. rules, and the source text is never wrong.
 */
const nameSeparator = /\s+and\s+/iy;

export function splitBibtexNames(value: string): BibtexNameList {
  const names: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === "\\") {
      index += 1;
      continue;
    }
    if (character === "{") depth += 1;
    else if (character === "}") depth = Math.max(0, depth - 1);
    else if (depth === 0 && /\s/.test(character)) {
      nameSeparator.lastIndex = index;
      if (!nameSeparator.test(value)) continue;
      names.push(value.slice(start, index));
      start = nameSeparator.lastIndex;
      index = start - 1;
    }
  }
  names.push(value.slice(start));
  const cleaned = names.map(displayName).filter(Boolean);
  const others = cleaned.length > 1 && cleaned[cleaned.length - 1].toLowerCase() === "others";
  return { names: others ? cleaned.slice(0, -1) : cleaned, others };
}

/** Trim a name and drop braces that only protect the whole name, such as `{World Health Organization}`. */
function displayName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}") && closingBrace(trimmed) === trimmed.length - 1) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function closingBrace(value: string): number {
  let depth = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === "\\") {
      index += 1;
      continue;
    }
    if (character === "{") depth += 1;
    else if (character === "}" && --depth === 0) return index;
  }
  return -1;
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
