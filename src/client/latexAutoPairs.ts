import { EditorState, Text, Transaction } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { latexOpaqueContextAt } from "../shared/latexLiterals";
import { findReusableLatexEnvironmentEnd, latexEnvironmentBeginStart } from "./latexFolding";

export interface LatexAutoPair {
  insert: string;
  cursorOffset: number;
  kind: "environment" | "delimiter";
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

function environmentMatch(context: ReturnType<typeof lineContext>): RegExpMatchArray | null {
  if (context.suffix.trim()) return null;
  return context.prefix.match(/^([ \t]*)\\begin\s*\{\s*([A-Za-z][A-Za-z0-9*:_-]*)\s*\}\s*$/);
}

function environmentPair(context: ReturnType<typeof lineContext>, match: RegExpMatchArray): LatexAutoPair | null {
  const environment = match[2];
  const doc = Text.of(context.nextSource.split("\n"));
  const beginStart = latexEnvironmentBeginStart(doc, context.cursor);
  if (beginStart !== null && findReusableLatexEnvironmentEnd(doc, beginStart, context.cursor, environment)) return null;
  const bodyIndent = match[1] + "\t";
  const insert = "\n" + bodyIndent + "\n" + match[1] + "\\end{" + environment + "}";
  return { insert, cursorOffset: 1 + bodyIndent.length, kind: "environment" };
}

function delimiterMatch(context: ReturnType<typeof lineContext>): RegExpMatchArray | null {
  if (context.suffix.trim()) return null;
  return context.prefix.match(/^(.*\\left\s*)(\\[{}]|[()[\]|.])\s*$/);
}

function delimiterPair(match: RegExpMatchArray): LatexAutoPair | null {
  const closing: Record<string, string> = {
    "(": "\\right)",
    ")": "\\right(",
    "[": "\\right]",
    "]": "\\right[",
    "|": "\\right|",
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
 * returned insertion in the same transaction as the original input.
 */
export function latexAutoPair(
  source: string,
  from: number,
  to: number,
  text: string
): LatexAutoPair | null {
  if (from !== to || !text) return null;
  const context = lineContext(source, from, text);
  const environment = environmentMatch(context);
  const delimiter = environment ? null : delimiterMatch(context);
  if (!environment && !delimiter) return null;
  if (latexOpaqueContextAt(context.nextSource, context.cursor)) return null;
  if (environment) return environmentPair(context, environment);
  if (delimiter) return delimiterPair(delimiter);
  return null;
}

export function latexAutoPairAtCursor(source: string, cursor: number): LatexAutoPair | null {
  if (cursor < 0 || cursor > source.length) return null;
  const context = lineContext(source, cursor, "");
  const environment = environmentMatch(context);
  const delimiter = environment ? null : delimiterMatch(context);
  if (!environment && !delimiter) return null;
  if (latexOpaqueContextAt(context.nextSource, context.cursor)) return null;
  if (environment) return environmentPair(context, environment);
  if (delimiter) return delimiterPair(delimiter);
  return null;
}

/** Keep automatic pairs atomic for undo, collaboration and source observers. */
export function latexAutoPairInput(view: EditorView, from: number, to: number, text: string, insert: () => Transaction): boolean {
  if (view.state.readOnly || view.composing || view.state.selection.ranges.length !== 1) return false;
  const pair = latexAutoPair(view.state.doc.toString(), from, to, text);
  if (!pair) return false;
  const input = insert();
  if (!input.docChanged) return false;
  const cursor = input.newSelection.main.head;
  view.dispatch(view.state.update(input, {
    sequential: true,
    changes: { from: cursor, insert: pair.insert },
    selection: { anchor: cursor + pair.cursorOffset },
    annotations: Transaction.userEvent.of("input.type")
  }));
  return true;
}

// closeBrackets may skip an already inserted '}' instead of changing the doc.
// Extend that transaction, never dispatch recursively from an update listener.
export const latexSkippedBracePair = EditorState.transactionFilter.of((transaction) => {
  if (transaction.docChanged || !transaction.selection || !transaction.isUserEvent("input")
    || transaction.startState.readOnly || transaction.newSelection.ranges.length !== 1
    || !transaction.newSelection.main.empty) return transaction;
  const cursor = transaction.newSelection.main.head;
  const pair = latexAutoPairAtCursor(transaction.newDoc.toString(), cursor);
  if (!pair) return transaction;
  return [transaction, {
    sequential: true,
    changes: { from: cursor, insert: pair.insert },
    selection: { anchor: cursor + pair.cursorOffset },
    userEvent: "input.complete"
  }];
});
