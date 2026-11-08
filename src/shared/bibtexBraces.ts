/**
 * Index just after the brace that closes the BibTeX group opened at `start`,
 * or -1 when the group is not closed. A backslash escapes the next character,
 * so `\{` and `\}` are not counted.
 */
export function bracedGroupEnd(source: string, start: number): number {
  let depth = 0;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (character === "\\") {
      index += 1;
      continue;
    }
    if (character === "{") depth += 1;
    else if (character === "}" && --depth === 0) return index + 1;
  }
  return -1;
}
