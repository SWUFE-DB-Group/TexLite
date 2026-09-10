import type { EditorState, Text } from "@codemirror/state";
import { foldService } from "@codemirror/language";
import { inlineLatexLiteralEnd, isLatexLiteralEnvironment } from "./latexLiterals";

interface EnvironmentCommand {
  kind: "begin" | "end";
  name: string;
  from: number;
  to: number;
}

const environmentCommand = /^\\(begin|end)\s*\{\s*([A-Za-z0-9@:_*.\-]+)\s*\}/;
const sectionCommand = /^\s*\\(part|chapter|section|subsection|subsubsection)\*?/;
const sectionLevels: Record<string, number> = { part: 0, chapter: 0, section: 1, subsection: 2, subsubsection: 3 };

function isEscaped(source: string, index: number): boolean {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && source[cursor] === "\\"; cursor -= 1) backslashes += 1;
  return backslashes % 2 === 1;
}

function codeEnd(text: string): number {
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "%" && !isEscaped(text, index)) return index;
  }
  return text.length;
}

function environmentCommands(text: string, start = 0): EnvironmentCommand[] {
  const end = codeEnd(text);
  const commands: EnvironmentCommand[] = [];
  let cursor = start;
  while (cursor < end) {
    if (text[cursor] !== "\\" || isEscaped(text, cursor)) {
      cursor += 1;
      continue;
    }
    const literalEnd = inlineLatexLiteralEnd(text, cursor, end);
    if (literalEnd !== null) {
      cursor = literalEnd;
      continue;
    }
    const match = environmentCommand.exec(text.slice(cursor, end));
    if (!match) {
      cursor += 1;
      continue;
    }
    const to = cursor + match[0].length;
    commands.push({ kind: match[1] as "begin" | "end", name: match[2], from: cursor, to });
    cursor = to;
  }
  return commands;
}

/**
 * Finds the matching environment close after a known opening command. The
 * scanner intentionally ignores comments and common literal environments so
 * that examples in listings do not change structural folding or completion.
 */
export function findMatchingLatexEnvironmentEnd(doc: Text, from: number, name: string): { from: number; to: number } | null {
  let line = doc.lineAt(Math.min(from, doc.length));
  let start = Math.max(0, from - line.from);
  let depth = 1;
  let literalEnvironment: string | null = null;

  for (let number = line.number; number <= doc.lines; number += 1) {
    line = doc.line(number);
    const commands = environmentCommands(line.text, start);
    start = 0;
    for (const command of commands) {
      if (literalEnvironment) {
        if (command.kind === "end" && command.name === literalEnvironment) literalEnvironment = null;
        continue;
      }
      if (command.kind === "begin" && isLatexLiteralEnvironment(command.name)) {
        literalEnvironment = command.name;
        continue;
      }
      if (command.name !== name) continue;
      if (command.kind === "begin") {
        depth += 1;
        continue;
      }
      depth -= 1;
      if (depth === 0) return { from: line.from + command.from, to: line.from + command.to };
    }
  }
  return null;
}

function findSectionFold(state: EditorState, lineStart: number): { from: number; to: number } | null {
  const line = state.doc.lineAt(lineStart);
  const section = sectionCommand.exec(line.text.slice(0, codeEnd(line.text)));
  if (!section) return null;
  const level = sectionLevels[section[1]];
  let literalEnvironment: string | null = null;

  for (let number = line.number + 1; number <= state.doc.lines; number += 1) {
    const candidate = state.doc.line(number);
    const commands = environmentCommands(candidate.text);
    for (const command of commands) {
      if (literalEnvironment) {
        if (command.kind === "end" && command.name === literalEnvironment) literalEnvironment = null;
      } else if (command.kind === "begin" && isLatexLiteralEnvironment(command.name)) {
        literalEnvironment = command.name;
      }
    }
    if (literalEnvironment) continue;
    const next = sectionCommand.exec(candidate.text.slice(0, codeEnd(candidate.text)));
    if (next && sectionLevels[next[1]] <= level) return { from: line.to, to: Math.max(line.to, candidate.from - 1) };
  }
  return line.to < state.doc.length ? { from: line.to, to: state.doc.length } : null;
}

export function findLatexFoldRange(state: EditorState, lineStart: number): { from: number; to: number } | null {
  const line = state.doc.lineAt(lineStart);
  const begin = environmentCommands(line.text).find((command) => command.kind === "begin");
  if (begin) {
    const end = findMatchingLatexEnvironmentEnd(state.doc, line.from + begin.to, begin.name);
    if (end && end.from > line.to) return { from: line.to, to: end.from };
  }
  return findSectionFold(state, lineStart);
}

export const latexFold = foldService.of((state, lineStart) => findLatexFoldRange(state, lineStart));
