import { api } from "./api";

export interface RawHarperLint {
  start: number;
  end: number;
  problem: string;
  kind: string;
  message: string;
  suggestions: string[];
}

export type SpellCheckIssueKind = "spelling" | "grammar";

export interface SpellCheckIssue {
  from: number;
  to: number;
  word: string;
  kind: SpellCheckIssueKind;
  message: string;
  suggestions: string[];
}

interface Span {
  from: number;
  to: number;
}

const keyTokenPattern = /([A-Za-z][A-Za-z0-9_.:/-]*(?:\s+[A-Za-z][A-Za-z0-9_.:/-]*){0,7})\s*$/;
const tableEnvironments = new Set(["tabular", "tabularx", "tabulary", "longtable", "array", "matrix", "pmatrix", "bmatrix", "Bmatrix", "vmatrix", "Vmatrix"]);
const nonProseEnvironments = new Set([
  "math", "displaymath", "equation", "equation*", "align", "align*", "alignat", "alignat*", "gather", "gather*", "multline", "multline*",
  "flalign", "flalign*", "tikzpicture", "axis", "scope", "pgfonlayer", "pgfpicture", "tabular", "tabularx", "tabulary", "longtable", "array",
  "matrix", "pmatrix", "bmatrix", "Bmatrix", "vmatrix", "Vmatrix", "verbatim", "Verbatim", "lstlisting", "minted", "comment", "algorithmic", "alignat"
]);
const optionCommands = new Set(["documentclass", "usepackage", "RequirePackage", "includegraphics", "tikzset", "pgfplotsset", "hypersetup", "lstset", "definecolor", "colorlet", "setlength", "setcounter", "draw", "path", "fill", "filldraw", "shade", "node", "addplot", "color", "textcolor", "colorbox", "pagecolor"]);
const identifierCommands = new Set(["label", "hypertarget", "ref", "pageref", "autoref", "nameref", "hyperref", "index", "gls", "Gls", "glspl", "Glspl", "cite", "citep", "citet", "citeauthor", "citeyear", "citenum", "parencite", "textcite", "autocite", "footcite"]);
const maxSuggestions = 5;
const lintResultCache = new Map<string, { source: string; dictionary: string; issues: SpellCheckIssue[] }>();
const maxCachedLintResults = 12;

interface PendingLintRequest {
  projectId: string;
  path: string;
  source: string;
  customWords: string[];
  resolve: (issues: SpellCheckIssue[]) => void;
  reject: (error: unknown) => void;
}

let activeLintRequest = false;
let pendingLintRequest: PendingLintRequest | null = null;

export class HarperLintSupersededError extends Error {
  constructor() {
    super("A newer writing check replaced this request.");
    this.name = "HarperLintSupersededError";
  }
}

export function isHarperLintSupersededError(error: unknown): error is HarperLintSupersededError {
  return error instanceof HarperLintSupersededError;
}

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

function matchingEnvironmentEnd(source: string, start: number, name: string): number | null {
  const tokenPattern = /\\(begin|end)\s*\{\s*([^{}]+?)\s*\}/g;
  tokenPattern.lastIndex = start;
  let depth = 1;
  for (let match = tokenPattern.exec(source); match; match = tokenPattern.exec(source)) {
    if (match[2].trim() !== name) continue;
    if (match[1] === "begin") depth += 1;
    else if (--depth === 0) return tokenPattern.lastIndex;
  }
  return null;
}

function addMathRanges(source: string, ranges: Span[]): void {
  for (const match of source.matchAll(/\\\((?:\\.|[^])*?\\\)|\\\[(?:\\.|[^])*?\\\]/g)) {
    if (match.index !== undefined) addRange(ranges, match.index, match.index + match[0].length);
  }
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] !== "$" || source[index - 1] === "\\") continue;
    const delimiter = source[index + 1] === "$" ? "$$" : "$";
    const end = source.indexOf(delimiter, index + delimiter.length);
    if (end >= 0) {
      addRange(ranges, index, end + delimiter.length);
      index = end + delimiter.length - 1;
    }
  }
}

/** Return source ranges that contain LaTeX syntax or non-prose content. */
export function ignoredRanges(source: string): Span[] {
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
          if (nonProseEnvironments.has(environmentName)) {
            const end = matchingEnvironmentEnd(source, environment.end, environmentName);
            if (end !== null) {
              addRange(ranges, commandStart, end);
              index = end - 1;
              continue;
            }
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

  addMathRanges(source, ranges);
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

/** Replace LaTeX syntax with spaces while preserving character positions. */
export function maskLatexSource(source: string): string {
  const ranges = ignoredRanges(source);
  const chars: string[] = [];
  let offset = 0;
  let rangeIndex = 0;
  for (const character of source) {
    while (rangeIndex < ranges.length && ranges[rangeIndex].to <= offset) rangeIndex += 1;
    const range = ranges[rangeIndex];
    chars.push(range && range.from <= offset && offset < range.to && character !== "\n" && character !== "\r" ? " " : character);
    offset += character.length;
  }
  return chars.join("");
}

function scalarOffsets(source: string): number[] {
  const offsets = [0];
  let offset = 0;
  for (const character of source) {
    offset += character.length;
    offsets.push(offset);
  }
  return offsets;
}

function dictionaryKey(words: string[]): string {
  return [...new Set(words.map((word) => word.trim()).filter(Boolean))].sort((left, right) => left.localeCompare(right)).join("\u0000");
}

async function requestHarperLints(projectId: string, path: string, source: string): Promise<RawHarperLint[]> {
  const result = await api<{ lints: RawHarperLint[] }>(`/api/projects/${projectId}/spellcheck`, {
    method: "POST",
    body: JSON.stringify({ path, source })
  });
  return result.lints;
}

function resolveLintSpan(source: string, masked: string, lint: RawHarperLint, scalarOffsetsMap: number[]): Span | null {
  const direct = { from: lint.start, to: lint.end };
  const scalar = {
    from: scalarOffsetsMap[lint.start] ?? -1,
    to: scalarOffsetsMap[lint.end] ?? -1
  };
  const candidates = [direct, scalar].filter((candidate, index, values) =>
    candidate.from >= 0 && candidate.to > candidate.from && candidate.to <= source.length
      && values.findIndex((value) => value.from === candidate.from && value.to === candidate.to) === index
  );
  if (candidates.length === 0) return null;

  // Harper's documented span units are Unicode scalar values, while some
  // released WASM builds expose JavaScript UTF-16 offsets. Prefer the range
  // whose masked text matches Harper's own problem text so both forms remain
  // correct for documents containing astral characters.
  return candidates.find((candidate) => masked.slice(candidate.from, candidate.to) === lint.problem)
    ?? candidates.find((candidate) => /[A-Za-z]/.test(masked.slice(candidate.from, candidate.to)))
    ?? candidates[0]
    ?? null;
}

function mapLint(source: string, masked: string, lint: RawHarperLint, offsets: number[]): SpellCheckIssue | null {
  const resolved = resolveLintSpan(source, masked, lint, offsets);
  if (!resolved) return null;
  const { from, to } = resolved;
  if (!/[A-Za-z]/.test(masked.slice(from, to))) return null;
  const word = source.slice(from, to);
  if (!word.trim() || /[\\%$]/.test(word)) return null;
  const kind = lint.kind === "Spelling" || lint.kind === "Typo" ? "spelling" : "grammar";
  const suggestions = lint.suggestions.filter((text, index, values) => index < maxSuggestions && values.indexOf(text) === index);
  return { from, to, word, kind, message: lint.message, suggestions };
}

function sourceCacheKey(source: string): string {
  let hash = 2166136261;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `${source.length}:${hash >>> 0}`;
}

function cachedLintResult(source: string, dictionary: string): SpellCheckIssue[] | null {
  const key = sourceCacheKey(source);
  const cached = lintResultCache.get(key);
  if (!cached || cached.source !== source || cached.dictionary !== dictionary) return null;
  lintResultCache.delete(key);
  lintResultCache.set(key, cached);
  return cached.issues;
}

function cacheLintResult(source: string, dictionary: string, issues: SpellCheckIssue[]): void {
  const key = sourceCacheKey(source);
  lintResultCache.set(key, { source, dictionary, issues });
  while (lintResultCache.size > maxCachedLintResults) {
    const oldest = lintResultCache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    lintResultCache.delete(oldest);
  }
}

export async function mapLatexLints(source: string, customWords: string[], lints: RawHarperLint[]): Promise<SpellCheckIssue[]> {
  const dictionary = dictionaryKey(customWords);
  const cached = cachedLintResult(source, dictionary);
  if (cached) return cached;
  const masked = maskLatexSource(source);
  const offsets = scalarOffsets(source);
  const projectWords = new Set(customWords.map((word) => word.trim().toLocaleLowerCase("en-US")).filter(Boolean));
  const issues = lints.map((lint) => mapLint(source, masked, lint, offsets)).filter((issue): issue is SpellCheckIssue => Boolean(issue))
    .filter((issue) => issue.kind !== "spelling" || !projectWords.has(issue.word.trim().toLocaleLowerCase("en-US")))
    .sort((left, right) => left.from - right.from || left.to - right.to);
  cacheLintResult(source, dictionary, issues);
  return issues;
}

async function lintLatexNow(projectId: string, path: string, source: string, customWords: string[]): Promise<SpellCheckIssue[]> {
  const dictionary = dictionaryKey(customWords);
  const cached = cachedLintResult(source, dictionary);
  if (cached) return cached;
  const masked = maskLatexSource(source);
  // Harper receives only masked prose. Project words stay outside its curated
  // dictionary and act as a cheap, project-scoped spelling addon.
  const lints = await requestHarperLints(projectId, path, masked);
  return mapLatexLints(source, customWords, lints);
}

async function runLatestLintRequest(): Promise<void> {
  if (activeLintRequest || !pendingLintRequest) return;
  const request = pendingLintRequest;
  pendingLintRequest = null;
  activeLintRequest = true;
  try {
    request.resolve(await lintLatexNow(request.projectId, request.path, request.source, request.customWords));
  } catch (error) {
    request.reject(error);
  } finally {
    activeLintRequest = false;
    void runLatestLintRequest();
  }
}

/** Run the latest Harper check, replacing obsolete checks still waiting in the global queue. */
export function lintLatex(projectId: string, path: string, source: string, customWords: string[] = []): Promise<SpellCheckIssue[]> {
  return new Promise((resolve, reject) => {
    pendingLintRequest?.reject(new HarperLintSupersededError());
    pendingLintRequest = { projectId, path, source, customWords: [...customWords], resolve, reject };
    void runLatestLintRequest();
  });
}
