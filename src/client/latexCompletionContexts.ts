import type { CompletionContext } from "@codemirror/autocomplete";
import type { Text } from "@codemirror/state";
import { findReusableLatexEnvironmentEnd, latexEnvironmentBeginStart } from "./latexFolding";
import { latexContextAt, type LatexCursorContext } from "./latex/context";

export interface LatexArgumentCompletionContext {
  from: number;
  query: string;
}

// Reuse one tree lookup for a completion request; never retain editor states
// in a global strong-reference cache or materialize the full source prefix.
const contextCache = new WeakMap<CompletionContext, LatexCursorContext>();
export function latexCompletionContext(context: CompletionContext): LatexCursorContext {
  let result = contextCache.get(context);
  if (!result) {
    result = latexContextAt(context.state, context.pos);
    contextCache.set(context, result);
  }
  return result;
}

export function latexEnvironmentCompletionContext(context: CompletionContext): (LatexArgumentCompletionContext & { command: "begin" | "end" }) | null {
  const argument = latexCompletionContext(context).argument;
  return argument?.kind === "environment"
    ? { from: argument.from, query: argument.query, command: argument.command as "begin" | "end" } : null;
}

export function latexCitationCompletionContext(context: CompletionContext): LatexArgumentCompletionContext | null {
  const argument = latexCompletionContext(context).argument;
  return argument?.kind === "citation" ? { from: argument.from, query: argument.query } : null;
}

export interface LatexEnvironmentCompletionPlan {
  to: number;
  insert: string;
  cursor: number;
  reusesExistingEnd: boolean;
}

/**
 * Build an environment completion without inserting a second closing command
 * when the document already has one below the cursor.
 */
export function latexEnvironmentCompletionPlan(doc: Text, from: number, to: number, name: string, command: "begin" | "end" = "begin"): LatexEnvironmentCompletionPlan {
  const closingBrace = doc.sliceString(to, to + 1) === "}" ? 1 : 0;
  const replacement = `${name}}`;
  const beginStart = latexEnvironmentBeginStart(doc, from);
  const reusableEnd = beginStart === null ? null : findReusableLatexEnvironmentEnd(doc, beginStart, to + closingBrace, name);
  if (command === "end" || reusableEnd) {
    return {
      to: to + closingBrace,
      insert: replacement,
      cursor: from + replacement.length,
      reusesExistingEnd: true
    };
  }
  const line = doc.lineAt(from);
  const indent = line.text.match(/^\s*/)?.[0] ?? "";
  return {
    to: to + closingBrace,
    insert: `${replacement}\n${indent}\t\n${indent}\\end{${name}}`,
    cursor: from + replacement.length + 1 + indent.length + 1,
    reusesExistingEnd: false
  };
}
