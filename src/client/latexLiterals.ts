const literalEnvironmentNames = [
  "verbatim", "verbatim*", "Verbatim", "BVerbatim", "LVerbatim", "SaveVerbatim", "VerbatimOut",
  "bverbatim", "bverbatim*", "lverbatim", "lverbatim*", "saveverbatim", "saveverbatim*", "verbatimout",
  "lstlisting", "lstlisting*", "minted", "minted*", "tcblisting", "alltt", "pygmented",
  "algorithmic", "algorithmicx", "filecontents", "filecontents*", "luacode", "luacodestar", "comment"
] as const;

const literalEnvironments = new Set<string>(literalEnvironmentNames);

export function isLatexLiteralEnvironment(name: string): boolean {
  return literalEnvironments.has(name);
}

function skipOptionalArgument(source: string, position: number, end: number): number | null {
  if (source[position] !== "[") return position;
  let depth = 1;
  for (let index = position + 1; index < end; index += 1) {
    if (source[index] === "\\") {
      index += 1;
      continue;
    }
    if (source[index] === "[") depth += 1;
    if (source[index] === "]") {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  return null;
}

function skipRequiredArgument(source: string, position: number, end: number): number | null {
  if (source[position] !== "{") return null;
  let depth = 1;
  for (let index = position + 1; index < end; index += 1) {
    if (source[index] === "\\") {
      index += 1;
      continue;
    }
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  return null;
}

/**
 * Return the offset just after a supported inline literal command, or null
 * when the text at `start` is not a complete inline literal. This is kept
 * deliberately small: it covers the forms which can otherwise make a later
 * `\\end{...}` or `$` look like actual LaTeX syntax.
 */
export function inlineLatexLiteralEnd(source: string, start: number, end = source.length): number | null {
  const command = /^\\(verb\*?|Verb\*?|lstinline\*?|mintinline\*?)(?![A-Za-z@])/.exec(source.slice(start, end));
  if (!command) return null;

  const name = command[1].replace(/\*$/, "");
  let position = start + command[0].length;
  if (name !== "verb") {
    const optionalEnd = skipOptionalArgument(source, position, end);
    if (optionalEnd === null) return null;
    position = optionalEnd;
  }
  if (name === "mintinline") {
    const languageEnd = skipRequiredArgument(source, position, end);
    if (languageEnd === null) return null;
    position = languageEnd;
  }

  const delimiter = source[position];
  if (!delimiter || /\s/.test(delimiter)) return null;
  const closing = source.indexOf(delimiter, position + 1);
  if (closing < 0 || closing >= end) return end;
  return closing + 1;
}

export function literalEnvironmentEnd(source: string, start: number, name: string): { from: number; to: number } | null {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(String.raw`\\end\s*\{\s*${escapedName}\s*\}`, "g");
  pattern.lastIndex = start;
  const match = pattern.exec(source);
  return match ? { from: match.index, to: match.index + match[0].length } : null;
}
