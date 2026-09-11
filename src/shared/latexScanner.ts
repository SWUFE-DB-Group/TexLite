/**
 * Offset-preserving lexical helpers shared by LaTeX reference, dependency,
 * outline-adjacent, and completion logic. This is intentionally a scanner,
 * not a TeX expansion engine: it understands comments, literal forms, command
 * boundaries, and balanced arguments without assigning package semantics.
 */

import { inlineLatexLiteralEnd, literalEnvironmentEnd, literalEnvironmentNames } from "./latexLiterals.js";

export interface LatexCommand {
  name: string;
  from: number;
  to: number;
}

export interface LatexArgumentSpan {
  from: number;
  to: number;
  contentFrom: number;
  contentTo: number;
}

const literalEnvironments = new Set<string>(literalEnvironmentNames);

function isCommandNameCharacter(character: string): boolean {
  return /[A-Za-z@0-9:_-]/.test(character);
}

export function isLatexEscaped(source: string, index: number): boolean {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && source[cursor] === "\\"; cursor -= 1) backslashes += 1;
  return backslashes % 2 === 1;
}

export function isLatexCommentStart(source: string, index: number): boolean {
  return source[index] === "%" && !isLatexEscaped(source, index);
}

export function skipLatexComment(source: string, index: number): number {
  const newline = source.indexOf("\n", index);
  return newline === -1 ? source.length : newline;
}

export function skipLatexTrivia(source: string, start: number): number {
  let index = start;
  while (index < source.length) {
    if (/\s/.test(source[index])) {
      index += 1;
      continue;
    }
    if (isLatexCommentStart(source, index)) {
      index = skipLatexComment(source, index);
      continue;
    }
    break;
  }
  return index;
}

/** Read one balanced braced or bracketed argument without changing offsets. */
export function readLatexBalancedArgument(
  source: string,
  start: number,
  opening: string,
  closing: string
): LatexArgumentSpan | null {
  if (source[start] !== opening) return null;
  let depth = 0;
  let braceDepth = 0;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (character === "\\" && index + 1 < source.length) {
      index += 1;
      continue;
    }
    if (isLatexCommentStart(source, index)) {
      index = skipLatexComment(source, index) - 1;
      continue;
    }
    // Braced content inside an optional argument can contain literal square
    // brackets, which must not close its outer option.
    if (opening === "[") {
      if (character === "{") {
        braceDepth += 1;
        continue;
      }
      if (character === "}" && braceDepth > 0) {
        braceDepth -= 1;
        continue;
      }
      if (braceDepth > 0) continue;
    }
    if (character === opening) {
      depth += 1;
      continue;
    }
    if (character !== closing) continue;
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
  return null;
}

export function readLatexMandatoryArguments(source: string, start: number, maximum: number): LatexArgumentSpan[] {
  const argumentsFound: LatexArgumentSpan[] = [];
  let index = start;
  while (argumentsFound.length < maximum) {
    index = skipLatexTrivia(source, index);
    while (source[index] === "[") {
      const optional = readLatexBalancedArgument(source, index, "[", "]");
      if (!optional) return argumentsFound;
      index = skipLatexTrivia(source, optional.to);
    }
    if (source[index] !== "{") break;
    const mandatory = readLatexBalancedArgument(source, index, "{", "}");
    if (!mandatory) break;
    argumentsFound.push(mandatory);
    index = mandatory.to;
  }
  return argumentsFound;
}

export function readLatexOptionalArguments(source: string, start: number, maximum: number): LatexArgumentSpan[] {
  const argumentsFound: LatexArgumentSpan[] = [];
  let index = start;
  while (argumentsFound.length < maximum) {
    index = skipLatexTrivia(source, index);
    if (source[index] !== "[") break;
    const optional = readLatexBalancedArgument(source, index, "[", "]");
    if (!optional) break;
    argumentsFound.push(optional);
    index = optional.to;
  }
  return argumentsFound;
}

function readLatexCommand(source: string, start: number): LatexCommand | null {
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

function skipLiteralEnvironment(source: string, command: LatexCommand): number {
  if (command.name !== "begin") return command.to;
  const environment = readLatexMandatoryArguments(source, command.to, 1)[0];
  if (!environment) return command.to;
  const name = source.slice(environment.contentFrom, environment.contentTo).trim();
  if (!literalEnvironments.has(name)) return command.to;
  return literalEnvironmentEnd(source, environment.to, name)?.to ?? source.length;
}

/**
 * Visit visible TeX commands in source order. Commands nested in arguments are
 * intentionally still visited; commands in comments and literal source forms
 * are not.
 */
export function forEachLatexCommand(source: string, visitor: (command: LatexCommand) => void): void {
  let index = 0;
  while (index < source.length) {
    if (isLatexCommentStart(source, index)) {
      index = skipLatexComment(source, index);
      continue;
    }
    if (source[index] !== "\\") {
      index += 1;
      continue;
    }
    const command = readLatexCommand(source, index);
    if (!command) {
      index += 1;
      continue;
    }
    const literalEnd = inlineLatexLiteralEnd(source, command.from);
    if (literalEnd !== null && literalEnd > command.to) {
      index = literalEnd;
      continue;
    }
    const environmentEnd = skipLiteralEnvironment(source, command);
    if (environmentEnd > command.to) {
      index = environmentEnd;
      continue;
    }
    visitor(command);
    index = command.to;
  }
}
