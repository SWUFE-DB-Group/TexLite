interface Span {
  from: number;
  to: number;
}

// This intentionally recognizes only the parts of LaTeX that are clearly not
// prose. It is a single-pass lexer, not a parser: malformed delimiters remain
// narrow, so they never hide the rest of a document or cause backtracking.
const nonProseEnvironments = new Set([
  "math", "displaymath", "equation", "equation*", "align", "align*", "alignat", "alignat*", "gather", "gather*", "multline", "multline*", "flalign", "flalign*",
  "tikzpicture", "axis", "scope", "pgfonlayer", "pgfpicture",
  "tabular", "tabularx", "tabulary", "longtable", "array", "matrix", "pmatrix", "bmatrix", "vmatrix",
  "verbatim", "lstlisting", "minted", "comment", "algorithmic"
]);
const opaqueArgumentCommands = new Set([
  "documentclass", "usepackage", "requirepackage", "includegraphics", "tikzset", "pgfplotsset", "hypersetup", "lstset",
  "label", "hypertarget", "ref", "pageref", "autoref", "nameref", "hyperref", "index", "gls", "glspl",
  "bibliography", "addbibresource", "input", "include", "url", "path", "setlength", "setcounter", "color", "textcolor", "colorbox", "pagecolor"
]);

function addRange(ranges: Span[], from: number, to: number): void {
  if (to > from) ranges.push({ from, to });
}

function isWhitespace(character: string | undefined): boolean {
  return character === " " || character === "\t" || character === "\r" || character === "\n";
}

function isCommandNameCharacter(character: string | undefined): boolean {
  if (!character) return false;
  const code = character.charCodeAt(0);
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || (code >= 48 && code <= 57)
    || character === "@" || character === ":" || character === "_";
}

function balancedArgument(source: string, start: number, open: string, close: string): Span | null {
  if (source[start] !== open) return null;
  let depth = 1;
  for (let index = start + 1; index < source.length; index += 1) {
    if (source[index] === "\\") {
      index += 1;
      continue;
    }
    if (source[index] === open) depth += 1;
    else if (source[index] === close && --depth === 0) return { from: start, to: index + 1 };
  }
  return null;
}

function skipWhitespace(source: string, start: number): number {
  let index = start;
  while (index < source.length && isWhitespace(source[index])) index += 1;
  return index;
}

function readCommand(source: string, start: number): { name: string; end: number } {
  let end = start + 1;
  if (isCommandNameCharacter(source[end])) while (isCommandNameCharacter(source[end])) end += 1;
  else if (end < source.length) end += 1;
  const name = source.slice(start + 1, end);
  if (source[end] === "*") end += 1;
  return { name, end };
}

function isCitationCommand(name: string): boolean {
  const normalized = name.toLocaleLowerCase("en-US");
  return normalized === "cite" || normalized.startsWith("cite") || normalized.endsWith("cite");
}

function masksOpaqueArguments(name: string): boolean {
  const normalized = name.toLocaleLowerCase("en-US");
  return opaqueArgumentCommands.has(normalized) || isCitationCommand(normalized) || normalized === "definecolor" || normalized === "colorlet" || normalized === "href";
}

function maskOpaqueArguments(source: string, start: number, name: string, ranges: Span[]): number {
  let cursor = start;
  const normalized = name.toLocaleLowerCase("en-US");
  const count = normalized === "definecolor" || normalized === "colorlet" ? 3 : 1;
  for (let index = 0; index < count; index += 1) {
    const argument = balancedArgument(source, cursor, "{", "}");
    if (!argument) break;
    addRange(ranges, argument.from, argument.to);
    cursor = skipWhitespace(source, argument.to);
  }
  return cursor;
}

function rawUrlEnd(source: string, start: number): number | null {
  const first = source[start];
  if (first !== "h" && first !== "H" && first !== "f" && first !== "F") return null;
  for (const prefix of ["http://", "https://", "ftp://"]) {
    if (source.slice(start, start + prefix.length).toLowerCase() !== prefix) continue;
    let end = start + prefix.length;
    while (end < source.length && !isWhitespace(source[end])) end += 1;
    return end;
  }
  return null;
}

function mergeOrderedRanges(ranges: Span[]): Span[] {
  const merged: Span[] = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (previous && range.from <= previous.to) previous.to = Math.max(previous.to, range.to);
    else merged.push({ ...range });
  }
  return merged;
}

/** Return ordered source spans that should not be sent to a prose checker. */
export function ignoredLatexRanges(source: string): Span[] {
  const ranges: Span[] = [];
  // Each non-prose environment installs its span at \begin and extends it at
  // \end. This preserves source order, so final merging stays linear.
  const nonProseStack: Array<{ name: string; range: Span }> = [];
  // The same technique keeps unmatched $ / \[ delimiters cheap and local.
  let pendingMath: { close: string; range: Span } | null = null;

  for (let index = 0; index < source.length;) {
    if (pendingMath?.close.startsWith("\\") && source.startsWith(pendingMath.close, index)) {
      pendingMath.range.to = index + pendingMath.close.length;
      index += pendingMath.close.length;
      pendingMath = null;
      continue;
    }

    if (source[index] === "%") {
      const end = source.indexOf("\n", index);
      addRange(ranges, index, end < 0 ? source.length : end);
      index = end < 0 ? source.length : end + 1;
      continue;
    }

    if (source[index] === "$") {
      if (pendingMath) {
        if (pendingMath.close === "$" || (pendingMath.close === "$$" && source.startsWith("$$", index))) {
          pendingMath.range.to = index + pendingMath.close.length;
          index += pendingMath.close.length;
          pendingMath = null;
        } else {
          index += 1;
        }
      } else {
        const delimiter = source[index + 1] === "$" ? "$$" : "$";
        const range = { from: index, to: index + delimiter.length };
        ranges.push(range);
        pendingMath = { close: delimiter, range };
        index += delimiter.length;
      }
      continue;
    }

    const urlEnd = rawUrlEnd(source, index);
    if (urlEnd !== null) {
      addRange(ranges, index, urlEnd);
      index = urlEnd;
      continue;
    }

    if (source[index] !== "\\") {
      index += 1;
      continue;
    }

    const commandStart = index;
    if (source[index + 1] === "(" || source[index + 1] === "[") {
      if (pendingMath) {
        addRange(ranges, commandStart, index + 2);
      } else {
        const range = { from: commandStart, to: index + 2 };
        ranges.push(range);
        pendingMath = { close: source[index + 1] === "(" ? "\\)" : "\\]", range };
      }
      index += 2;
      continue;
    }

    const command = readCommand(source, commandStart);
    let cursor = skipWhitespace(source, command.end);
    if (command.name === "verb") {
      addRange(ranges, commandStart, command.end);
      const delimiter = source[cursor];
      if (delimiter && !isWhitespace(delimiter)) {
        const end = source.indexOf(delimiter, cursor + 1);
        if (end >= 0) {
          addRange(ranges, cursor, end + 1);
          cursor = end + 1;
        }
      }
      index = Math.max(command.end, cursor);
      continue;
    }

    if (command.name === "begin" || command.name === "end") {
      const environment = balancedArgument(source, cursor, "{", "}");
      if (!environment) {
        addRange(ranges, commandStart, command.end);
        index = command.end;
        continue;
      }
      const environmentName = source.slice(environment.from + 1, environment.to - 1).trim().toLocaleLowerCase("en-US");
      cursor = skipWhitespace(source, environment.to);
      let options: Span | null = null;
      if (command.name === "begin") {
        options = balancedArgument(source, cursor, "[", "]");
        if (options) cursor = skipWhitespace(source, options.to);
        if (nonProseEnvironments.has(environmentName)) {
          const range = { from: commandStart, to: cursor };
          ranges.push(range);
          nonProseStack.push({ name: environmentName, range });
        } else {
          addRange(ranges, commandStart, command.end);
          addRange(ranges, environment.from, environment.to);
          if (options) addRange(ranges, options.from, options.to);
        }
      } else {
        const open = nonProseStack.at(-1);
        if (open?.name === environmentName) {
          nonProseStack.pop();
          open.range.to = cursor;
        } else {
          addRange(ranges, commandStart, command.end);
          addRange(ranges, environment.from, environment.to);
        }
      }
      index = Math.max(command.end, cursor);
      continue;
    }

    addRange(ranges, commandStart, command.end);
    const options = balancedArgument(source, cursor, "[", "]");
    if (options) {
      addRange(ranges, options.from, options.to);
      cursor = skipWhitespace(source, options.to);
    }
    if (masksOpaqueArguments(command.name)) cursor = maskOpaqueArguments(source, cursor, command.name, ranges);
    index = Math.max(command.end, cursor);
  }

  return mergeOrderedRanges(ranges);
}

/** Replace syntax with spaces while retaining Unicode-scalar offsets and line breaks. */
export function maskLatexSource(source: string): string {
  const ranges = ignoredLatexRanges(source);
  const chars: string[] = [];
  let offset = 0;
  let rangeIndex = 0;
  for (const character of source) {
    while (rangeIndex < ranges.length && ranges[rangeIndex].to <= offset) rangeIndex += 1;
    const range = ranges[rangeIndex];
    const masked = range && range.from <= offset && offset < range.to && character !== "\n" && character !== "\r";
    // `harper-cli` reports Unicode scalar positions. One space for every
    // source scalar keeps diagnostics aligned after masked astral characters.
    chars.push(masked ? " " : character);
    offset += character.length;
  }
  return chars.join("");
}
