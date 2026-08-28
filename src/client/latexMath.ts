export interface LatexMathRange {
  /** Inclusive source offset of the opening delimiter or environment. */
  from: number;
  /** Exclusive source offset after the closing delimiter or environment. */
  to: number;
  /** TeX passed to the preview renderer, without its outer delimiter. */
  source: string;
  displayMode: boolean;
}

const mathEnvironments = new Set([
  "math", "displaymath", "equation", "align", "alignat", "flalign", "gather", "multline",
  "split", "aligned", "alignedat", "gathered", "matrix", "pmatrix", "bmatrix", "vmatrix",
  "cases", "dcases", "rcases", "smallmatrix", "subarray", "array"
]);

const verbatimEnvironments = new Set([
  "verbatim", "verbatimwrite", "bverbatim", "lverbatim", "saveverbatim", "lstlisting",
  "minted", "comment", "alltt", "tcblisting", "pygmented"
]);

interface EnvironmentCommand {
  type: "begin" | "end";
  name: string;
  end: number;
}

function isEscaped(source: string, position: number): boolean {
  let slashCount = 0;
  for (let cursor = position - 1; cursor >= 0 && source[cursor] === "\\"; cursor -= 1) slashCount += 1;
  return slashCount % 2 === 1;
}

function skipComment(source: string, position: number): number {
  const newline = source.indexOf("\n", position);
  return newline < 0 ? source.length : newline + 1;
}

function normalizeEnvironmentName(name: string): string {
  return name.replace(/\*$/, "").toLowerCase();
}

function readEnvironmentCommand(source: string, position: number): EnvironmentCommand | null {
  if (source[position] !== "\\" || isEscaped(source, position)) return null;
  const match = /^\\(begin|end)[ \t]*\{[ \t]*([^{}\s]+)[ \t]*\}/.exec(source.slice(position));
  if (!match) return null;
  return { type: match[1] as "begin" | "end", name: match[2], end: position + match[0].length };
}

function skipInlineVerb(source: string, position: number): number | null {
  if (source[position] !== "\\" || isEscaped(source, position)) return null;
  const match = /^\\verb\*?(?![A-Za-z@])/.exec(source.slice(position));
  if (!match) return null;
  const delimiterPosition = position + match[0].length;
  const delimiter = source[delimiterPosition];
  if (!delimiter || delimiter === "\n" || delimiter === "\r") return skipComment(source, delimiterPosition);
  const end = source.indexOf(delimiter, delimiterPosition + 1);
  return end < 0 ? skipComment(source, delimiterPosition) : end + 1;
}

function findDelimitedEnd(source: string, position: number, delimiter: "dollar" | "paren" | "bracket", stopAtLineBreak = false): number {
  for (let cursor = position; cursor < source.length; cursor += 1) {
    if (stopAtLineBreak && (source[cursor] === "\n" || source[cursor] === "\r")) return -1;
    if (source[cursor] === "%" && !isEscaped(source, cursor)) {
      cursor = skipComment(source, cursor) - 1;
      continue;
    }
    if (delimiter === "dollar" && source[cursor] === "$" && !isEscaped(source, cursor)) return cursor;
    if (delimiter === "paren" && source[cursor] === "\\" && source[cursor + 1] === ")" && !isEscaped(source, cursor)) return cursor;
    if (delimiter === "bracket" && source[cursor] === "\\" && source[cursor + 1] === "]" && !isEscaped(source, cursor)) return cursor;
  }
  return -1;
}

function findDoubleDollarEnd(source: string, position: number): number {
  for (let cursor = position; cursor < source.length - 1; cursor += 1) {
    if (source[cursor] === "%" && !isEscaped(source, cursor)) {
      cursor = skipComment(source, cursor) - 1;
      continue;
    }
    if (source[cursor] === "$" && source[cursor + 1] === "$" && !isEscaped(source, cursor)) return cursor;
  }
  return -1;
}

function findEnvironmentEnd(source: string, position: number, environmentName: string): { from: number; to: number } | null {
  let depth = 1;
  for (let cursor = position; cursor < source.length; cursor += 1) {
    if (source[cursor] === "%" && !isEscaped(source, cursor)) {
      cursor = skipComment(source, cursor) - 1;
      continue;
    }
    const verbEnd = skipInlineVerb(source, cursor);
    if (verbEnd !== null) {
      cursor = verbEnd - 1;
      continue;
    }
    const command = readEnvironmentCommand(source, cursor);
    if (!command || command.name !== environmentName) continue;
    if (command.type === "begin") depth += 1;
    else if (--depth === 0) return { from: cursor, to: command.end };
    cursor = command.end - 1;
  }
  return null;
}

function isInside(range: LatexMathRange, position: number, side: -1 | 1): boolean {
  return position >= range.from && (position < range.to || (position === range.to && side < 0));
}

function stripCommentsForPreview(source: string): string {
  let result = "";
  for (let cursor = 0; cursor < source.length; cursor += 1) {
    if (source[cursor] === "%" && !isEscaped(source, cursor)) {
      const end = skipComment(source, cursor);
      if (end > cursor && source[end - 1] === "\n") result += "\n";
      cursor = end - 1;
      continue;
    }
    result += source[cursor];
  }
  // Labels affect the document, but are not meaningful in an isolated math preview.
  return result.replace(/\\(?:label|notag|nonumber)\b(?:[ \t]*\{[^{}]*\})?/g, "");
}

function previewEnvironmentSource(source: string, name: string, bodyFrom: number, bodyTo: number): string {
  let body = stripCommentsForPreview(source.slice(bodyFrom, bodyTo));
  const normalized = normalizeEnvironmentName(name);
  if (normalized === "equation" || normalized === "displaymath") return body;
  if (normalized === "align" || normalized === "flalign") return `\\begin{aligned}${body}\\end{aligned}`;
  if (normalized === "alignat") {
    body = body.replace(/^\s*\{[^{}]*\}/, "");
    return `\\begin{aligned}${body}\\end{aligned}`;
  }
  if (normalized === "gather" || normalized === "multline") return `\\begin{gathered}${body}\\end{gathered}`;
  return stripCommentsForPreview(source);
}

function createRange(from: number, to: number, source: string, displayMode: boolean): LatexMathRange {
  return { from, to, source: stripCommentsForPreview(source), displayMode };
}

/** Whether a file type is a LaTeX source form for which hover previews make sense. */
export function supportsLatexMathHover(filePath: string): boolean {
  return /\.(?:tex|ltx|sty|cls)$/i.test(filePath);
}

/**
 * Locate the delimited LaTeX math expression beneath a CodeMirror document
 * position. The scanner deliberately recognizes common LaTeX forms rather
 * than attempting to parse an entire document.
 */
export function findLatexMathRangeAt(source: string, position: number, side: -1 | 1 = 1): LatexMathRange | null {
  const target = Math.max(0, Math.min(source.length, position));
  for (let cursor = 0; cursor < source.length; cursor += 1) {
    if (source[cursor] === "%" && !isEscaped(source, cursor)) {
      cursor = skipComment(source, cursor) - 1;
      continue;
    }

    const verbEnd = skipInlineVerb(source, cursor);
    if (verbEnd !== null) {
      cursor = verbEnd - 1;
      continue;
    }

    const environment = readEnvironmentCommand(source, cursor);
    if (environment?.type === "begin") {
      const normalized = normalizeEnvironmentName(environment.name);
      const isVerbatim = verbatimEnvironments.has(normalized);
      const isMath = mathEnvironments.has(normalized);
      if (!isVerbatim && !isMath) continue;
      const end = findEnvironmentEnd(source, environment.end, environment.name);
      if (isVerbatim) {
        if (end) cursor = end.to - 1;
        else cursor = source.length;
        continue;
      }
      if (isMath && end) {
        const range: LatexMathRange = {
          from: cursor,
          to: end.to,
          source: previewEnvironmentSource(source.slice(cursor, end.to), environment.name, environment.end - cursor, end.from - cursor),
          displayMode: true
        };
        if (isInside(range, target, side)) return range;
        cursor = end.to - 1;
        continue;
      }
    }

    if (source[cursor] === "\\" && !isEscaped(source, cursor) && (source[cursor + 1] === "(" || source[cursor + 1] === "[")) {
      const displayMode = source[cursor + 1] === "[";
      const end = findDelimitedEnd(source, cursor + 2, displayMode ? "bracket" : "paren");
      if (end >= 0) {
        const range = createRange(cursor, end + 2, source.slice(cursor + 2, end), displayMode);
        if (isInside(range, target, side)) return range;
        cursor = range.to - 1;
        continue;
      }
    }

    if (source[cursor] !== "$" || isEscaped(source, cursor)) continue;
    const displayMode = source[cursor + 1] === "$";
    const openingLength = displayMode ? 2 : 1;
    const end = displayMode
      ? findDoubleDollarEnd(source, cursor + 2)
      : findDelimitedEnd(source, cursor + 1, "dollar", true);
    if (end < 0) continue;
    if (!displayMode && source[end + 1] === "$") {
      // A single-dollar opener cannot close against the first half of `$$`.
      cursor = end;
      continue;
    }
    const range = createRange(cursor, end + openingLength, source.slice(cursor + openingLength, end), displayMode);
    if (isInside(range, target, side)) return range;
    cursor = range.to - 1;
  }
  return null;
}
