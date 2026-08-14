export interface LatexAutoPair {
  insert: string;
  cursorOffset: number;
  kind: "environment" | "delimiter";
}

function isCommentBeforeCursor(line: string): boolean {
  let backslashes = 0;
  for (const character of line) {
    if (character === "\\") {
      backslashes += 1;
      continue;
    }
    if (character === "%" && backslashes % 2 === 0) return true;
    backslashes = 0;
  }
  return false;
}

function escapeRegExp(value: string): string {
  const metacharacters = ".+?^$()[]{}|\\";
  return [...value].map((character) => metacharacters.includes(character) ? "\\" + character : character).join("");
}

function lineContext(source: string, from: number, text: string): {
  nextSource: string;
  cursor: number;
  prefix: string;
  suffix: string;
} {
  const nextSource = source.slice(0, from) + text + source.slice(from);
  const cursor = from + text.length;
  const lineStart = nextSource.lastIndexOf("\n", Math.max(0, cursor - 1)) + 1;
  const lineEnd = nextSource.indexOf("\n", cursor);
  return {
    nextSource,
    cursor,
    prefix: nextSource.slice(lineStart, cursor),
    suffix: nextSource.slice(cursor, lineEnd < 0 ? nextSource.length : lineEnd)
  };
}

function environmentPair(context: ReturnType<typeof lineContext>): LatexAutoPair | null {
  const match = context.prefix.match(/^([ \t]*)\\begin\s*\{\s*([A-Za-z][A-Za-z0-9*:_-]*)\s*\}\s*$/);
  if (!match || context.suffix.trim() || isCommentBeforeCursor(context.prefix)) return null;
  const environment = match[2];
  const escaped = escapeRegExp(environment);
  const alreadyClosed = new RegExp(
    "^[ \\t]*\\n[ \\t]*\\\\end\\s*\\{\\s*" + escaped + "\\s*\\}"
  ).test(context.nextSource.slice(context.cursor));
  if (alreadyClosed) return null;
  const bodyIndent = match[1] + "\t";
  const insert = "\n" + bodyIndent + "\n" + match[1] + "\\end{" + environment + "}";
  return { insert, cursorOffset: 1 + bodyIndent.length, kind: "environment" };
}

function delimiterPair(context: ReturnType<typeof lineContext>): LatexAutoPair | null {
  if (context.suffix.trim() || isCommentBeforeCursor(context.prefix)) return null;
  const match = context.prefix.match(/^(.*\\left\s*)(\\[{}]|[()[\]|.])\s*$/);
  if (!match) return null;
  const closing: Record<string, string> = {
    "(": "\\right)",
    ")": "\\right(",
    "[": "\\right]",
    "]": "\\right[",
    "|": "\\right|",
    ".": "\\right.",
    "\\{": "\\right\\}",
    "\\}": "\\right\\{"
  };
  const insert = closing[match[2]];
  if (!insert) return null;
  return { insert, cursorOffset: 0, kind: "delimiter" };
}

/**
 * Returns a closing insertion when a user has just completed a safe, standalone
 * LaTeX environment or scalable delimiter expression. The caller can apply the
 * returned insertion after the original input transaction.
 */
export function latexAutoPair(
  source: string,
  from: number,
  to: number,
  text: string
): LatexAutoPair | null {
  if (from !== to || !text) return null;
  const context = lineContext(source, from, text);
  return environmentPair(context) ?? delimiterPair(context);
}

export function latexAutoPairAtCursor(source: string, cursor: number): LatexAutoPair | null {
  if (cursor < 0 || cursor > source.length) return null;
  const context = lineContext(source, cursor, "");
  return environmentPair(context) ?? delimiterPair(context);
}
