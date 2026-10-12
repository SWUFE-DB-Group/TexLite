import type { Text } from "@codemirror/state";
import { inlineLatexLiteralEnd, isLatexLiteralEnvironment, literalEnvironmentEnd } from "./latexLiterals";
import { maskLatexComments } from "../shared/latexLiterals";
import { readLatexBalancedArgument, skipLatexTrivia } from "../shared/latexScanner";

interface EnvironmentCommand {
  kind: "begin" | "end";
  name: string;
  from: number;
  to: number;
}

const environmentCommand = /^\\(begin|end)(?![A-Za-z@])/;
const environmentName = /^[A-Za-z0-9@:_*.+\-]+$/;
const incompleteBeginCommand = /\\begin\s*\{\s*[A-Za-z0-9@:_*.+\-]*\s*\}?$/;
const environmentLookahead = 8_192;

function isEscaped(source: string, index: number): boolean {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && source[cursor] === "\\"; cursor -= 1) backslashes += 1;
  return backslashes % 2 === 1;
}

function* environmentCommands(doc: Text, start = 0, literal: { name: string | null } = { name: null }): Generator<EnvironmentCommand> {
  // Keep line-based literal/comment handling, but allow a real begin/end
  // argument to cross lines. Only that argument gets bounded lookahead.
  let position = start;
  for (let number = doc.lineAt(Math.min(start, doc.length)).number; number <= doc.lines; number++) {
    const line = doc.line(number);
    const text = line.text;
    let cursor = Math.max(0, position - line.from);
    while (cursor < text.length) {
      if (literal.name) {
        const close = literalEnvironmentEnd(text, cursor, literal.name);
        if (!close) break;
        yield { kind: "end", name: literal.name, from: line.from + close.from, to: line.from + close.to };
        literal.name = null;
        cursor = close.to;
        continue;
      }
      if (text[cursor] === "%" && !isEscaped(text, cursor)) break;
      if (text[cursor] !== "\\" || isEscaped(text, cursor)) { cursor++; continue; }
      const literalEnd = inlineLatexLiteralEnd(text, cursor, text.length);
      if (literalEnd !== null) { cursor = literalEnd; continue; }
      const match = environmentCommand.exec(text.slice(cursor));
      if (!match) { cursor++; continue; }
      const from = line.from + cursor;
      const tokenEnd = from + match[0].length;
      const argumentSource = doc.sliceString(tokenEnd, Math.min(doc.length, tokenEnd + environmentLookahead));
      const argument = readLatexBalancedArgument(argumentSource, skipLatexTrivia(argumentSource, 0), "{", "}");
      const name = argument && maskLatexComments(argumentSource.slice(argument.contentFrom, argument.contentTo)).trim();
      if (!argument || !name || !environmentName.test(name)) { cursor += match[0].length; continue; }
      const to = tokenEnd + argument.to;
      yield { kind: match[1] as "begin" | "end", name, from, to };
      if (match[1] === "begin" && isLatexLiteralEnvironment(name)) literal.name = name;
      cursor = to - line.from;
    }
    position = Math.max(line.to + 1, line.from + cursor);
  }
}

/**
 * Finds the matching environment close after a known opening command. The
 * scanner intentionally ignores comments and common literal environments so
 * that examples in listings do not change structural folding or completion.
 */
export function findMatchingLatexEnvironmentEnd(doc: Text, from: number, name: string): { from: number; to: number } | null {
  let depth = 1;
  const literal = { name: isLatexLiteralEnvironment(name) ? name : null };
  for (const command of environmentCommands(doc, from, literal)) {
    if (command.name !== name) continue;
    if (command.kind === "begin") {
      depth += 1;
      continue;
    }
    depth -= 1;
    if (depth === 0) return { from: command.from, to: command.to };
  }
  return null;
}

/** Locate a nearby begin command, including trivia on preceding lines. */
export function latexEnvironmentBeginStart(doc: Text, position: number): number | null {
  const start = Math.max(0, position - environmentLookahead);
  const prefix = maskLatexComments(doc.sliceString(start, position));
  const match = incompleteBeginCommand.exec(prefix);
  return match && !isEscaped(prefix, match.index) ? start + match.index : null;
}

function existingEnvironmentOwnsEnd(doc: Text, beginStart: number, endStart: number, name: string): boolean {
  const stack: Array<{ name: string; from: number }> = [];
  for (const command of environmentCommands(doc)) {
    if (command.from >= endStart) return stack.at(-1)?.name === name && (stack.at(-1)?.from ?? beginStart) < beginStart;
    // This is the unfinished command being completed. Its existing spelling
    // must not make a later end look like an old matching pair.
    if (command.from === beginStart && command.kind === "begin") continue;
    if (command.kind === "begin") {
      stack.push({ name: command.name, from: command.from });
    } else if (stack.at(-1)?.name === command.name) {
      stack.pop();
    }
  }
  return false;
}

/**
 * Find an end command that belongs to an unfinished begin command, while
 * preserving an already balanced outer environment of the same name.
 */
export function findReusableLatexEnvironmentEnd(doc: Text, beginStart: number, afterBegin: number, name: string): { from: number; to: number } | null {
  const end = findMatchingLatexEnvironmentEnd(doc, afterBegin, name);
  if (!end || existingEnvironmentOwnsEnd(doc, beginStart, end.from, name)) return null;
  return end;
}
