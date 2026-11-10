import { EditorState, Text, Transaction } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { latexOpaqueContextAt } from "../shared/latexLiterals";
import { findReusableLatexEnvironmentEnd, latexEnvironmentBeginStart, latexEnvironmentTakesArguments } from "./latexFolding";

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
  return { insert, cursorOffset: latexEnvironmentTakesArguments(environment) ? 0 : 1 + bodyIndent.length, kind: "environment" };
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

function mayAutoPair(doc: Text, cursor: number, text: string): boolean {
  const line = doc.lineAt(cursor);
  const context = lineContext(line.text, cursor - line.from, text);
  return Boolean(environmentMatch(context) || delimiterMatch(context));
}

const escapedClosers: Readonly<Record<string, string>> = { "[": "\\]", "(": "\\)", "{": "\\}" };
/** A sized delimiter is closed by its own command, never by a bare closer. */
const sizedDelimiter = /\\(?:left|right|middle|[bB]igg?[lmr]?)\s*\\$/;

/** The character before `position` is a backslash that is not itself escaped. */
function followsActiveBackslash(doc: Text, position: number): boolean {
  let count = 0;
  while (position - count > 0 && count < 64 && doc.sliceString(position - count - 1, position - count) === "\\") count += 1;
  return count % 2 === 1;
}

/** `\[`, `\(` and `\{` close with their escaped forms; a plain closer would be wrong TeX. */
function escapedDelimiterInput(view: EditorView, from: number, to: number, text: string, insert: () => Transaction): boolean {
  const { doc } = view.state;
  if (from !== to || !followsActiveBackslash(doc, from)) return false;
  // Typing the closer by hand steps over the one already there.
  if (text.length === 1 && "])}".includes(text) && doc.sliceString(from, from + 2) === "\\" + text) {
    view.dispatch({ changes: { from: from - 1, to: from }, selection: { anchor: from + 1 }, userEvent: "input.type" });
    return true;
  }
  const closer = escapedClosers[text];
  if (!closer || latexOpaqueContextAt(doc.toString(), from)) return false;
  const next = doc.sliceString(from, from + 1);
  const pairs = (!next || /[\s)\]}:;>]/.test(next)) && !sizedDelimiter.test(doc.sliceString(doc.lineAt(from).from, from));
  const input = insert();
  if (!pairs) { view.dispatch(input); return true; }
  const cursor = input.newSelection.main.head;
  view.dispatch(view.state.update(input, { sequential: true, changes: { from: cursor, insert: closer }, selection: { anchor: cursor }, annotations: Transaction.userEvent.of("input.type") }));
  return true;
}

/** Backspace in an empty `\[|\]` removes the pair, as it does for plain brackets. */
export function deleteLatexEscapedPair(view: EditorView): boolean {
  const { state } = view;
  const { main, ranges } = state.selection;
  if (state.readOnly || ranges.length !== 1 || !main.empty || main.head < 2) return false;
  const before = state.sliceDoc(main.head - 2, main.head);
  if (before[0] !== "\\" || escapedClosers[before[1]] === undefined || state.sliceDoc(main.head, main.head + 2) !== escapedClosers[before[1]]
    || !followsActiveBackslash(state.doc, main.head - 1)) return false;
  view.dispatch({ changes: { from: main.head - 2, to: main.head + 2 }, scrollIntoView: true, userEvent: "delete.backward" });
  return true;
}

/** Enter after the arguments of a just-paired environment goes to its empty body. */
export function enterLatexEnvironmentBody(view: EditorView): boolean {
  const { state } = view;
  const { main, ranges } = state.selection;
  if (state.readOnly || ranges.length !== 1 || !main.empty) return false;
  const line = state.doc.lineAt(main.head);
  if (main.head !== line.to || line.number + 2 > state.doc.lines) return false;
  const name = /^[ \t]*\\begin\s*\{\s*([^{}\s]+)\s*\}/.exec(line.text)?.[1];
  const body = state.doc.line(line.number + 1);
  if (!name || body.text.trim() || state.doc.line(line.number + 2).text.trim() !== "\\end{" + name + "}") return false;
  view.dispatch({ selection: { anchor: body.to }, scrollIntoView: true, userEvent: "select" });
  return true;
}

/** Keep automatic pairs atomic for undo, collaboration and source observers. */
export function latexAutoPairInput(view: EditorView, from: number, to: number, text: string, insert: () => Transaction): boolean {
  if (view.state.readOnly || view.composing || view.state.selection.ranges.length !== 1) return false;
  // Ordinary prose never needs a whole-document string or literal-state scan.
  // Reuse the exact insertion predicates before materializing global context.
  const pair = from === to && text && mayAutoPair(view.state.doc, from, text) ? latexAutoPair(view.state.doc.toString(), from, to, text) : null;
  if (!pair) return escapedDelimiterInput(view, from, to, text, insert);
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

/** closeBrackets steps over a closer by replacing it with the same character. */
function leavesDocumentUnchanged(transaction: Transaction): boolean {
  if (!transaction.docChanged) return true;
  let same = true;
  transaction.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    same &&= toA - fromA === inserted.length && transaction.startState.sliceDoc(fromA, toA) === inserted.toString();
  });
  return same;
}

// Extend the transaction that steps over an auto-inserted '}', never dispatch
// recursively from an update listener.
export const latexSkippedBracePair = EditorState.transactionFilter.of((transaction) => {
  if (!transaction.selection || !transaction.isUserEvent("input") || !leavesDocumentUnchanged(transaction)
    || transaction.startState.readOnly || transaction.newSelection.ranges.length !== 1
    || !transaction.newSelection.main.empty) return transaction;
  const cursor = transaction.newSelection.main.head;
  if (!mayAutoPair(transaction.newDoc, cursor, "")) return transaction;
  const pair = latexAutoPairAtCursor(transaction.newDoc.toString(), cursor);
  if (!pair) return transaction;
  return [transaction, {
    sequential: true,
    changes: { from: cursor, insert: pair.insert },
    selection: { anchor: cursor + pair.cursorOffset },
    userEvent: "input.complete"
  }];
});
