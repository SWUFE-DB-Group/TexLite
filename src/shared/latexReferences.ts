/**
 * Small, offset-preserving LaTeX scanners used by both the editor and the
 * server-side reference resolver. This deliberately is not a full TeX
 * parser: it only understands command boundaries, balanced arguments,
 * comments, and the literal forms which must never be interpreted as TeX.
 */

import { literalEnvironmentNames } from "./latexLiterals.js";

export type LatexReferenceKind = "citation" | "label";

export interface LatexReference {
  kind: LatexReferenceKind;
  command: string;
  key: string;
  from: number;
  to: number;
}

export interface LatexReferenceDefinition {
  key: string;
  command: string;
  targetFrom: number;
  targetTo: number;
  source: "label" | "bibitem" | "bibtex";
}

export interface LatexPathReference {
  path: string;
  command: string;
  from: number;
  to: number;
}

interface LatexCommand {
  name: string;
  from: number;
  to: number;
}

interface ArgumentSpan {
  from: number;
  to: number;
  contentFrom: number;
  contentTo: number;
}

const literalEnvironments = new Set<string>(literalEnvironmentNames);

const inlineLiteralCommands = new Set(["verb", "Verb", "lstinline", "mintinline"]);

function isCommandNameCharacter(character: string): boolean {
  return /[A-Za-z@0-9:_-]/.test(character);
}

function isEscaped(source: string, index: number): boolean {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && source[cursor] === "\\"; cursor -= 1) backslashes += 1;
  return backslashes % 2 === 1;
}

function isCommentStart(source: string, index: number): boolean {
  return source[index] === "%" && !isEscaped(source, index);
}

function skipComment(source: string, index: number): number {
  const newline = source.indexOf("\n", index);
  return newline === -1 ? source.length : newline;
}

function skipTrivia(source: string, start: number): number {
  let index = start;
  while (index < source.length) {
    if (/\s/.test(source[index])) {
      index += 1;
      continue;
    }
    if (isCommentStart(source, index)) {
      index = skipComment(source, index);
      continue;
    }
    break;
  }
  return index;
}

function readBalancedArgument(source: string, start: number, opening: string, closing: string): ArgumentSpan | null {
  if (source[start] !== opening) return null;
  let depth = 0;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (character === "\\" && index + 1 < source.length) {
      index += 1;
      continue;
    }
    if (isCommentStart(source, index)) {
      index = skipComment(source, index) - 1;
      continue;
    }
    if (character === opening) {
      depth += 1;
      continue;
    }
    if (character === closing) {
      depth -= 1;
      if (depth === 0) {
        return {
          from: start,
          to: index + 1,
          contentFrom: start + 1,
          contentTo: index
        };
      }
    }
  }
  return null;
}

function readCommand(source: string, start: number): LatexCommand | null {
  if (source[start] !== "\\" || start + 1 >= source.length) return null;
  let index = start + 1;
  if (!/[A-Za-z@]/.test(source[index])) {
    return { name: source[index], from: start, to: index + 1 };
  }
  while (index < source.length && isCommandNameCharacter(source[index])) index += 1;
  const name = source.slice(start + 1, index);
  if (source[index] === "*") index += 1;
  return { name, from: start, to: index };
}

function readMandatoryArguments(source: string, start: number, maximum: number): ArgumentSpan[] {
  const argumentsFound: ArgumentSpan[] = [];
  let index = start;
  while (argumentsFound.length < maximum) {
    index = skipTrivia(source, index);
    while (source[index] === "[") {
      const optional = readBalancedArgument(source, index, "[", "]");
      if (!optional) return argumentsFound;
      index = skipTrivia(source, optional.to);
    }
    if (source[index] !== "{") break;
    const mandatory = readBalancedArgument(source, index, "{", "}");
    if (!mandatory) break;
    argumentsFound.push(mandatory);
    index = mandatory.to;
  }
  return argumentsFound;
}

function readOptionalArguments(source: string, start: number, maximum: number): ArgumentSpan[] {
  const argumentsFound: ArgumentSpan[] = [];
  let index = start;
  while (argumentsFound.length < maximum) {
    index = skipTrivia(source, index);
    if (source[index] !== "[") break;
    const optional = readBalancedArgument(source, index, "[", "]");
    if (!optional) break;
    argumentsFound.push(optional);
    index = optional.to;
  }
  return argumentsFound;
}

function skipDelimitedLiteral(source: string, start: number): number {
  const index = skipTrivia(source, start);
  if (index >= source.length) return source.length;
  if (source[index] === "{") return readBalancedArgument(source, index, "{", "}")?.to ?? source.length;
  const delimiter = source[index];
  if (/\s/.test(delimiter)) return index + 1;
  for (let cursor = index + 1; cursor < source.length; cursor += 1) {
    if (source[cursor] === "\\" && cursor + 1 < source.length) {
      cursor += 1;
      continue;
    }
    if (source[cursor] === delimiter) return cursor + 1;
    if (source[cursor] === "\n") return cursor;
  }
  return source.length;
}

function skipInlineLiteral(source: string, command: LatexCommand): number {
  if (!inlineLiteralCommands.has(command.name)) return command.to;
  let index = skipTrivia(source, command.to);
  while (source[index] === "[") {
    const optional = readBalancedArgument(source, index, "[", "]");
    if (!optional) return source.length;
    index = skipTrivia(source, optional.to);
  }
  if (command.name === "mintinline") {
    const language = readBalancedArgument(source, index, "{", "}");
    if (!language) return skipDelimitedLiteral(source, index);
    index = skipTrivia(source, language.to);
    while (source[index] === "[") {
      const optional = readBalancedArgument(source, index, "[", "]");
      if (!optional) return source.length;
      index = skipTrivia(source, optional.to);
    }
  }
  return skipDelimitedLiteral(source, index);
}

function skipLiteralEnvironment(source: string, command: LatexCommand): number {
  if (command.name !== "begin") return command.to;
  const environment = readMandatoryArguments(source, command.to, 1)[0];
  if (!environment) return command.to;
  const name = source.slice(environment.contentFrom, environment.contentTo).trim();
  if (!literalEnvironments.has(name)) return command.to;
  const escapedName = name.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
  const closingPattern = new RegExp("\\\\end\\s*\\{\\s*" + escapedName + "\\s*\\}", "g");
  closingPattern.lastIndex = environment.to;
  const match = closingPattern.exec(source);
  return match ? match.index + match[0].length : source.length;
}

function forEachLatexCommand(source: string, visitor: (command: LatexCommand) => void): void {
  let index = 0;
  while (index < source.length) {
    if (isCommentStart(source, index)) {
      index = skipComment(source, index);
      continue;
    }
    if (source[index] !== "\\") {
      index += 1;
      continue;
    }
    const command = readCommand(source, index);
    if (!command) {
      index += 1;
      continue;
    }
    const literalEnd = skipInlineLiteral(source, command);
    if (literalEnd > command.to) {
      index = literalEnd;
      continue;
    }
    const environmentEnd = skipLiteralEnvironment(source, command);
    if (environmentEnd > command.to) {
      index = environmentEnd;
      continue;
    }
    visitor(command);
    // Intentionally consume only the command itself. Commands inside optional
    // and mandatory arguments must still be visible to this scanner.
    index = command.to;
  }
}

function keyRanges(source: string, argument: ArgumentSpan): Array<{ key: string; from: number; to: number }> {
  const ranges: Array<{ key: string; from: number; to: number }> = [];
  let segmentStart = argument.contentFrom;
  for (let index = argument.contentFrom; index <= argument.contentTo; index += 1) {
    if (index !== argument.contentTo && source[index] !== ",") continue;
    let from = segmentStart;
    let to = index;
    while (from < to && /\s/.test(source[from])) from += 1;
    while (to > from && /\s/.test(source[to - 1])) to -= 1;
    if (to > from) ranges.push({ key: source.slice(from, to), from, to });
    segmentStart = index + 1;
  }
  return ranges;
}

function isCitationCommand(name: string): boolean {
  const normalized = name.toLowerCase();
  return normalized === "nocite" || normalized.includes("cite");
}

function isLabelCommand(name: string): boolean {
  const normalized = name.toLowerCase();
  // \href has the same suffix as \ref but its first argument is a URL, not a
  // cross-reference target. Keeping it out avoids misleading decorations.
  return normalized !== "href"
    && (normalized === "ref" || normalized.endsWith("ref") || normalized === "cref" || normalized === "crefrange");
}

function isRangeReferenceCommand(name: string): boolean {
  return name.toLowerCase() === "crefrange";
}

function isMultiCitationCommand(name: string): boolean {
  return name.toLowerCase().endsWith("cites");
}

/**
 * Return individual keys inside visible citation and cross-reference commands.
 * The scanner purposefully finds nested commands as well, for example a
 * citation in a caption's optional argument.
 */
export function findLatexReferences(source: string): LatexReference[] {
  const references: LatexReference[] = [];
  forEachLatexCommand(source, (command) => {
    const kind: LatexReferenceKind | null = isCitationCommand(command.name)
      ? "citation"
      : isLabelCommand(command.name) ? "label" : null;
    if (!kind) return;
    const argumentCount = kind === "citation"
      ? isMultiCitationCommand(command.name) ? Number.MAX_SAFE_INTEGER : 1
      : isRangeReferenceCommand(command.name) ? 2 : 1;
    const argumentsFound = kind === "label" && command.name.toLowerCase() === "hyperref"
      ? readOptionalArguments(source, command.to, 1)
      : readMandatoryArguments(source, command.to, argumentCount);
    for (const argument of argumentsFound) {
      for (const range of keyRanges(source, argument)) {
        references.push({ kind, command: command.name, ...range });
      }
    }
  });
  return references.sort((left, right) => left.from - right.from || left.to - right.to);
}

export function latexReferenceAt(source: string, offset: number): LatexReference | null {
  return findLatexReferences(source).find((reference) => offset >= reference.from && offset < reference.to) ?? null;
}

/**
 * Replace LaTeX comments with spaces without shifting any source offset.
 */
export function maskLatexComments(source: string): string {
  const characters = source.split("");
  let index = 0;
  while (index < source.length) {
    if (!isCommentStart(source, index)) {
      index += 1;
      continue;
    }
    const end = skipComment(source, index);
    for (let cursor = index; cursor < end; cursor += 1) characters[cursor] = " ";
    index = end;
  }
  return characters.join("");
}

function definitionsFromLatex(source: string, kind: LatexReferenceKind): LatexReferenceDefinition[] {
  const definitions: LatexReferenceDefinition[] = [];
  forEachLatexCommand(source, (command) => {
    if (kind === "label" && (command.name === "label" || command.name === "hypertarget")) {
      const argument = readMandatoryArguments(source, command.to, 1)[0];
      if (!argument) return;
      for (const range of keyRanges(source, argument)) {
        definitions.push({
          key: range.key,
          command: command.name,
          targetFrom: command.from,
          targetTo: argument.to,
          source: "label"
        });
      }
      return;
    }
    if (kind === "citation" && command.name === "bibitem") {
      const argument = readMandatoryArguments(source, command.to, 1)[0];
      if (!argument) return;
      for (const range of keyRanges(source, argument)) {
        definitions.push({
          key: range.key,
          command: command.name,
          targetFrom: command.from,
          targetTo: argument.to,
          source: "bibitem"
        });
      }
    }
  });
  return definitions;
}

function readBibtexBlock(source: string, start: number): ArgumentSpan | null {
  const opening = source[start];
  const closing = opening === "{" ? "}" : ")";
  if (opening !== "{" && opening !== "(") return null;
  let depth = 0;
  let quoted = false;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (character === "\\" && index + 1 < source.length) {
      index += 1;
      continue;
    }
    if (character === "\"" && !isEscaped(source, index)) {
      quoted = !quoted;
      continue;
    }
    if (quoted) continue;
    if (character === opening) {
      depth += 1;
      continue;
    }
    if (character === closing) {
      depth -= 1;
      if (depth === 0) {
        return {
          from: start,
          to: index + 1,
          contentFrom: start + 1,
          contentTo: index
        };
      }
    }
  }
  return null;
}

function bibtexKeyRange(source: string, entry: ArgumentSpan): { key: string; from: number; to: number } | null {
  let from = entry.contentFrom;
  while (from < entry.contentTo && /\s/.test(source[from])) from += 1;
  if (from >= entry.contentTo) return null;
  let to = from;
  while (to < entry.contentTo && source[to] !== "," && !/\s/.test(source[to])) to += 1;
  let trimmedTo = to;
  while (trimmedTo > from && /\s/.test(source[trimmedTo - 1])) trimmedTo -= 1;
  if (trimmedTo <= from) return null;
  const separator = skipTrivia(source, to);
  if (separator < entry.contentTo && source[separator] !== ",") return null;
  return { key: source.slice(from, trimmedTo), from, to: trimmedTo };
}

function definitionsFromBibtex(source: string): LatexReferenceDefinition[] {
  const masked = maskLatexComments(source);
  const definitions: LatexReferenceDefinition[] = [];
  let index = 0;
  while (index < masked.length) {
    if (masked[index] !== "@") {
      index += 1;
      continue;
    }
    let typeEnd = index + 1;
    while (typeEnd < masked.length && /[A-Za-z]/.test(masked[typeEnd])) typeEnd += 1;
    if (typeEnd === index + 1) {
      index += 1;
      continue;
    }
    let opening = typeEnd;
    while (opening < masked.length && /\s/.test(masked[opening])) opening += 1;
    const block = readBibtexBlock(masked, opening);
    if (!block) {
      index = typeEnd;
      continue;
    }
    const type = masked.slice(index + 1, typeEnd).toLowerCase();
    if (type !== "string" && type !== "preamble" && type !== "comment") {
      const key = bibtexKeyRange(source, block);
      if (key) {
        definitions.push({
          key: key.key,
          command: "bibtex",
          targetFrom: index,
          targetTo: block.to,
          source: "bibtex"
        });
      }
    }
    // Skip the whole entry. This is important for @comment entries that
    // happen to contain text resembling another BibTeX record.
    index = block.to;
  }
  return definitions;
}

export function findLatexReferenceDefinitions(
  source: string,
  kind: LatexReferenceKind,
  bibtex = false
): LatexReferenceDefinition[] {
  if (bibtex) return kind === "citation" ? definitionsFromBibtex(source) : [];
  return definitionsFromLatex(source, kind);
}

function pathRanges(source: string, argument: ArgumentSpan, splitOnComma: boolean): LatexPathReference[] {
  const paths: LatexPathReference[] = [];
  let segmentStart = argument.contentFrom;
  for (let index = argument.contentFrom; index <= argument.contentTo; index += 1) {
    if (index !== argument.contentTo && (!splitOnComma || source[index] !== ",")) continue;
    let from = segmentStart;
    let to = index;
    while (from < to && /\s/.test(source[from])) from += 1;
    while (to > from && /\s/.test(source[to - 1])) to -= 1;
    if (to > from) paths.push({ path: source.slice(from, to), command: "", from, to });
    segmentStart = index + 1;
  }
  return paths;
}

/**
 * Find source files pulled into a LaTeX document. Paths are intentionally raw
 * here; project-level code validates and resolves them against the project
 * tree before reading anything.
 */
export function findLatexSourceIncludes(source: string): LatexPathReference[] {
  const includes: LatexPathReference[] = [];
  forEachLatexCommand(source, (command) => {
    const name = command.name.toLowerCase();
    if (name === "input" || name === "include" || name === "subfile") {
      const argument = readMandatoryArguments(source, command.to, 1)[0];
      if (!argument) return;
      for (const include of pathRanges(source, argument, false)) includes.push({ ...include, command: command.name });
      return;
    }
    if (name !== "import" && name !== "subimport" && name !== "includefrom" && name !== "inputfrom") return;
    const argumentsFound = readMandatoryArguments(source, command.to, 2);
    if (argumentsFound.length !== 2) return;
    const directory = source.slice(argumentsFound[0].contentFrom, argumentsFound[0].contentTo).trim();
    const file = source.slice(argumentsFound[1].contentFrom, argumentsFound[1].contentTo).trim();
    if (!directory || !file) return;
    const separator = directory.endsWith("/") ? "" : "/";
    includes.push({
      path: directory + separator + file,
      command: command.name,
      from: argumentsFound[1].contentFrom,
      to: argumentsFound[1].contentTo
    });
  });
  return includes;
}

/**
 * Find bibliography resources declared by a LaTeX document.
 */
export function findLatexBibliographyFiles(source: string): LatexPathReference[] {
  const files: LatexPathReference[] = [];
  forEachLatexCommand(source, (command) => {
    const name = command.name.toLowerCase();
    if (name !== "bibliography" && name !== "addbibresource" && name !== "addglobalbib" && name !== "addsectionbib") return;
    const argument = readMandatoryArguments(source, command.to, 1)[0];
    if (!argument) return;
    const splitOnComma = name === "bibliography";
    for (const file of pathRanges(source, argument, splitOnComma)) files.push({ ...file, command: command.name });
  });
  return files;
}

export function lineAndColumnAt(source: string, offset: number): { line: number; column: number } {
  const boundedOffset = Math.max(0, Math.min(offset, source.length));
  let line = 1;
  let lineStart = 0;
  for (let index = 0; index < boundedOffset; index += 1) {
    if (source[index] !== "\n") continue;
    line += 1;
    lineStart = index + 1;
  }
  return { line, column: boundedOffset - lineStart + 1 };
}
