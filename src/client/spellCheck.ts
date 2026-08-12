import nspell from "nspell";
import aff from "../../node_modules/dictionary-en/index.aff?raw";
import dic from "../../node_modules/dictionary-en/index.dic?raw";

export interface SpellCheckIssue {
  from: number;
  to: number;
  word: string;
}

interface Span {
  from: number;
  to: number;
}

// Keep the Hunspell dictionary in the browser bundle.  No source text is sent
// to the server for spelling checks.
const checker = nspell(aff, dic);
const wordPattern = /[A-Za-z][A-Za-z0-9]*(?:['’][A-Za-z0-9]+)*/g;
const keyTokenPattern = /([A-Za-z][A-Za-z0-9_.:/-]*(?:\s+[A-Za-z][A-Za-z0-9_.:/-]*){0,7})\s*$/;
const tableEnvironments = new Set(["tabular", "tabularx", "tabulary", "longtable", "array", "matrix", "pmatrix", "bmatrix", "Bmatrix", "vmatrix", "Vmatrix"]);
const optionCommands = new Set(["documentclass", "usepackage", "RequirePackage", "includegraphics", "tikzset", "pgfplotsset", "hypersetup", "lstset", "definecolor", "colorlet", "setlength", "setcounter", "draw", "path", "fill", "filldraw", "shade", "node", "addplot"]);
const identifierCommands = new Set(["label", "hypertarget", "ref", "pageref", "autoref", "nameref", "hyperref", "index", "gls", "Gls", "glspl", "Glspl", "cite", "citep", "citet", "citeauthor", "citeyear", "citenum", "parencite", "textcite", "autocite", "footcite"]);

function addRange(ranges: Span[], from: number, to: number): void {
  if (to > from) ranges.push({ from, to });
}

function balancedArgument(source: string, start: number, open: string, close: string): { from: number; to: number; end: number } | null {
  if (source[start] !== open) return null;
  let depth = 0;
  for (let index = start; index < source.length; index += 1) {
    const escaped = source[index - 1] === "\\" && source[index - 2] !== "\\";
    if (!escaped && source[index] === open) depth += 1;
    if (!escaped && source[index] === close) {
      depth -= 1;
      if (depth === 0) return { from: start, to: index + 1, end: index + 1 };
    }
  }
  return null;
}

function skipWhitespace(source: string, start: number): number {
  let index = start;
  while (index < source.length && /[ \t\r\n]/.test(source[index])) index += 1;
  return index;
}

function isCommentStart(source: string, position: number): boolean {
  if (source[position] !== "%") return false;
  let slashes = 0;
  for (let index = position - 1; index >= 0 && source[index] === "\\"; index -= 1) slashes += 1;
  return slashes % 2 === 0;
}

function optionLike(value: string): boolean {
  return /[=,!/]/.test(value) || /\b(?:colorbar|legend|width|height|draw|fill|style|domain|samples|anchor|at|axis)\b/.test(value);
}

function identifierCommand(name: string): boolean {
  return identifierCommands.has(name) || /^cite[A-Za-z]*/.test(name);
}

function addKeyValueRanges(source: string, ranges: Span[]): void {
  for (let equals = source.indexOf("="); equals >= 0; equals = source.indexOf("=", equals + 1)) {
    const delimiters = ["\n", "[", "{", "]", "}", ",", ";"];
    const segmentStart = Math.max(...delimiters.map((delimiter) => source.lastIndexOf(delimiter, equals - 1) + 1));
    const segment = source.slice(segmentStart, equals);
    const key = segment.match(keyTokenPattern);
    if (key?.index !== undefined) addRange(ranges, segmentStart + key.index, equals);

    let valueStart = equals + 1;
    while (valueStart < source.length && /\s/.test(source[valueStart])) valueStart += 1;
    let valueEnd = valueStart;
    if (source[valueStart] === "{") {
      const argument = balancedArgument(source, valueStart, "{", "}");
      valueEnd = argument?.end ?? valueStart;
    } else {
      while (valueEnd < source.length && !/[,\]\}\n]/.test(source[valueEnd])) valueEnd += 1;
    }
    addRange(ranges, valueStart, valueEnd);
  }
}

function ignoredRanges(source: string): Span[] {
  const ranges: Span[] = [];
  const commandPattern = /[A-Za-z@]/;
  for (let index = 0; index < source.length; index += 1) {
    if (isCommentStart(source, index)) {
      const end = source.indexOf("\n", index);
      addRange(ranges, index, end < 0 ? source.length : end);
      index = end < 0 ? source.length : end;
      continue;
    }
    if (source[index] !== "\\") continue;
    const commandStart = index;
    let commandEnd = index + 1;
    if (commandPattern.test(source[commandEnd] ?? "")) {
      while (commandEnd < source.length && /[A-Za-z@0-9:_]/.test(source[commandEnd])) commandEnd += 1;
    } else if (commandEnd < source.length) {
      commandEnd += 1;
    }
    const name = source.slice(index + 1, commandEnd);
    addRange(ranges, commandStart, commandEnd);
    let cursor = skipWhitespace(source, commandEnd);

    if (name === "begin" || name === "end") {
      const environment = balancedArgument(source, cursor, "{", "}");
      if (environment) {
        addRange(ranges, environment.from, environment.to);
        const environmentName = source.slice(environment.from + 1, environment.to - 1).trim();
        cursor = skipWhitespace(source, environment.end);
        if (name === "begin") {
          const options = balancedArgument(source, cursor, "[", "]");
          if (options) { addRange(ranges, options.from, options.to); cursor = skipWhitespace(source, options.end); }
          if (tableEnvironments.has(environmentName)) {
            const columnSpec = balancedArgument(source, cursor, "{", "}");
            if (columnSpec) addRange(ranges, columnSpec.from, columnSpec.to);
          }
        }
      }
      index = commandEnd - 1;
      continue;
    }

    if (identifierCommand(name)) {
      if (source[cursor] === "*") cursor = skipWhitespace(source, cursor + 1);
      while (true) {
        const argument = balancedArgument(source, cursor, "[", "]") ?? balancedArgument(source, cursor, "{", "}");
        if (!argument) break;
        addRange(ranges, argument.from, argument.to);
        cursor = skipWhitespace(source, argument.end);
      }
    } else {
      const options = balancedArgument(source, cursor, "[", "]");
      if (options && (optionCommands.has(name) || optionLike(source.slice(options.from + 1, options.to - 1)))) {
        addRange(ranges, options.from, options.to);
        cursor = skipWhitespace(source, options.end);
      }
      if (optionCommands.has(name)) {
        const argumentsToSkip = name === "definecolor" || name === "colorlet" ? 3 : 1;
        for (let count = 0; count < argumentsToSkip; count += 1) {
          const argument = balancedArgument(source, cursor, "{", "}");
          if (!argument) break;
          addRange(ranges, argument.from, argument.to);
          cursor = skipWhitespace(source, argument.end);
        }
      }
    }
    index = commandEnd - 1;
  }

  addKeyValueRanges(source, ranges);
  for (const match of source.matchAll(/(?:https?|ftp):\/\/[^\s]+/gi)) {
    if (match.index !== undefined) addRange(ranges, match.index, match.index + match[0].length);
  }

  ranges.sort((left, right) => left.from - right.from || left.to - right.to);
  const merged: Span[] = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (previous && range.from <= previous.to) previous.to = Math.max(previous.to, range.to);
    else merged.push({ ...range });
  }
  return merged;
}

function isInside(ranges: Span[], position: number, cursor: { index: number }): boolean {
  while (cursor.index < ranges.length && ranges[cursor.index].to <= position) cursor.index += 1;
  const range = ranges[cursor.index];
  return Boolean(range && range.from <= position && position < range.to);
}

export function checkSpelling(source: string, customWords: string[] = []): SpellCheckIssue[] {
  const ignored = ignoredRanges(source);
  const ignoredCursor = { index: 0 };
  const custom = new Set(customWords.map((word) => word.toLocaleLowerCase("en-US")));
  const issues: SpellCheckIssue[] = [];
  for (const match of source.matchAll(wordPattern)) {
    if (match.index === undefined) continue;
    const word = match[0];
    const from = match.index;
    const to = from + word.length;
    if (isInside(ignored, from, ignoredCursor)) continue;
    if (word.length < 2 || /\d/.test(word) || /^[A-Z]/.test(word)) continue;
    if (custom.has(word.toLocaleLowerCase("en-US")) || checker.correct(word)) continue;
    issues.push({ from, to, word });
  }
  return issues;
}
