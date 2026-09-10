// Literal TeX syntax used as opaque editor regions. `alltt` does permit a
// subset of TeX commands, but treating its raw body as opaque prevents its
// delimiters from leaking into ordinary source highlighting and tooling.
export const literalEnvironmentNames = [
  "verbatim", "verbatim*", "Verbatim", "BVerbatim", "LVerbatim", "SaveVerbatim", "VerbatimOut",
  "bverbatim", "bverbatim*", "lverbatim", "lverbatim*", "saveverbatim", "saveverbatim*", "verbatimout",
  "verbatimwrite", "lstlisting", "lstlisting*", "minted", "minted*", "tcblisting", "tcblisting*", "pygmented", "alltt",
  "filecontents", "filecontents*", "luacode", "luacodestar", "comment"
] as const;

const literalEnvironments = new Set<string>(literalEnvironmentNames);

export type LatexOpaqueContext = "comment" | "literal";

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
 * when the text at `start` is not one. An unfinished literal owns the
 * remainder of its line. This is deliberately small: it covers the forms
 * which can otherwise make a later `\\end{...}` or `$` look like actual
 * LaTeX syntax.
 */
interface InlineLatexLiteralSpan {
  end: number;
  closed: boolean;
}

function inlineLatexLiteralSpan(source: string, start: number, end = source.length): InlineLatexLiteralSpan | null {
  const newline = source.indexOf("\n", start);
  if (newline >= 0) end = Math.min(end, newline);
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
  // For verb, '{' is still a symmetric delimiter, not an argument opener.
  if (delimiter === "{" && name !== "verb") {
    const requiredEnd = skipRequiredArgument(source, position, end);
    return { end: requiredEnd ?? end, closed: requiredEnd !== null };
  }
  const closing = source.indexOf(delimiter, position + 1);
  if (closing < 0 || closing >= end) return { end, closed: false };
  return { end: closing + 1, closed: true };
}

export function inlineLatexLiteralEnd(source: string, start: number, end = source.length): number | null {
  return inlineLatexLiteralSpan(source, start, end)?.end ?? null;
}

export function literalEnvironmentEnd(source: string, start: number, name: string): { from: number; to: number } | null {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(String.raw`\\end\s*\{\s*${escapedName}\s*\}`, "g");
  pattern.lastIndex = start;
  const match = pattern.exec(source);
  return match ? { from: match.index, to: match.index + match[0].length } : null;
}

function isEscaped(source: string, index: number): boolean {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && source[cursor] === "\\"; cursor -= 1) backslashes += 1;
  return backslashes % 2 === 1;
}

function commandEnd(source: string, start: number): number {
  let cursor = start + 1;
  if (/[A-Za-z@]/.test(source[cursor] ?? "")) {
    while (/[A-Za-z@]/.test(source[cursor] ?? "")) cursor += 1;
    if (source[cursor] === "*") cursor += 1;
    return cursor;
  }
  return Math.min(source.length, cursor + 1);
}

function literalEnvironmentBegin(source: string, start: number): { name: string; to: number } | null {
  const match = /^\\begin\s*\{\s*([A-Za-z0-9@:_*.\-]+)\s*\}/.exec(source.slice(start));
  if (!match || !isLatexLiteralEnvironment(match[1])) return null;
  return { name: match[1], to: start + match[0].length };
}

/**
 * Return whether a position is inside a TeX comment or one of the literal
 * code forms shared by editor tooling. Positions after a completed literal are
 * deliberately treated as normal source, including when its delimiter is '%'.
 */
export function latexOpaqueContextAt(source: string, position: number): LatexOpaqueContext | null {
  const target = Math.max(0, Math.min(source.length, position));
  for (let cursor = 0; cursor < target;) {
    if (source[cursor] === "%" && !isEscaped(source, cursor)) {
      const newline = source.indexOf("\n", cursor);
      const end = newline < 0 ? source.length : newline;
      if (target <= end) return "comment";
      cursor = end + 1;
      continue;
    }
    if (source[cursor] !== "\\" || isEscaped(source, cursor)) {
      cursor += 1;
      continue;
    }
    const inline = inlineLatexLiteralSpan(source, cursor);
    if (inline !== null) {
      if (target < inline.end || (!inline.closed && target <= inline.end)) return "literal";
      cursor = inline.end;
      continue;
    }
    const environment = literalEnvironmentBegin(source, cursor);
    if (environment) {
      const close = literalEnvironmentEnd(source, environment.to, environment.name);
      const end = close?.to ?? source.length;
      if (target < end || (!close && target <= end)) return "literal";
      cursor = end;
      continue;
    }
    cursor = commandEnd(source, cursor);
  }
  return null;
}

function maskRange(source: string, from: number, to: number): string {
  return source.slice(from, to).replace(/[^\r\n]/g, " ");
}

/** Mask ordinary TeX comments while preserving every source offset. */
export function maskLatexComments(source: string): string {
  const characters = source.split("");
  for (let cursor = 0; cursor < source.length; cursor += 1) {
    if (source[cursor] !== "%" || isEscaped(source, cursor)) continue;
    const newline = source.indexOf("\n", cursor);
    const end = newline < 0 ? source.length : newline;
    for (let index = cursor; index < end; index += 1) characters[index] = " ";
    cursor = end;
  }
  return characters.join("");
}

/**
 * Mask literal source while preserving offsets and line structure. Callers can
 * then use lightweight regular expressions without learning project commands
 * declared inside listings or verbatim examples.
 */
export function maskLatexLiteralContent(source: string): string {
  let result = "";
  let cursor = 0;
  while (cursor < source.length) {
    if (source[cursor] === "%" && !isEscaped(source, cursor)) {
      const newline = source.indexOf("\n", cursor);
      const end = newline < 0 ? source.length : newline;
      result += source.slice(cursor, end);
      cursor = end;
      continue;
    }
    if (source[cursor] !== "\\" || isEscaped(source, cursor)) {
      result += source[cursor];
      cursor += 1;
      continue;
    }
    const inlineEnd = inlineLatexLiteralEnd(source, cursor);
    if (inlineEnd !== null) {
      result += maskRange(source, cursor, inlineEnd);
      cursor = inlineEnd;
      continue;
    }
    const environment = literalEnvironmentBegin(source, cursor);
    if (environment) {
      const close = literalEnvironmentEnd(source, environment.to, environment.name);
      const end = close?.to ?? source.length;
      result += maskRange(source, cursor, end);
      cursor = end;
      continue;
    }
    result += source[cursor];
    cursor += 1;
  }
  return result;
}
