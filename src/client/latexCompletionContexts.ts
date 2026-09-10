import type { CompletionContext } from "@codemirror/autocomplete";
import type { Text } from "@codemirror/state";
import { findMatchingLatexEnvironmentEnd } from "./latexFolding";

export interface LatexArgumentCompletionContext {
  from: number;
  query: string;
}

// A completion query tries several contexts. Materialize the prefix once,
// rather than flattening the CodeMirror document for each regular expression.
const prefixCache = new WeakMap<CompletionContext, string>();
function prefixFor(context: CompletionContext): string {
  let prefix = prefixCache.get(context);
  if (prefix === undefined) {
    prefix = context.state.sliceDoc(0, context.pos);
    prefixCache.set(context, prefix);
  }
  return prefix;
}

export function latexArgumentCompletionContext(context: CompletionContext, pattern: RegExp, commaSeparated = false): LatexArgumentCompletionContext | null {
  const before = prefixFor(context);
  const match = before.match(pattern);
  if (!match || match.index === undefined) return null;
  const argument = { from: context.pos - match[1].length, query: match[1] };
  return commaSeparated ? currentListItem(argument) : argument;
}

export function latexEnvironmentCompletionContext(context: CompletionContext): (LatexArgumentCompletionContext & { command: "begin" | "end" }) | null {
  const before = prefixFor(context);
  const match = before.match(/\\(begin|end)\s*\{([^{}]*)$/);
  if (!match || match.index === undefined) return null;
  return { from: context.pos - match[2].length, query: match[2], command: match[1] as "begin" | "end" };
}

export function latexCitationCompletionContext(context: CompletionContext): LatexArgumentCompletionContext | null {
  const argument = latexArgumentCompletionContext(
    context,
    /\\(?:nocite|(?:cite|parencite|textcite|autocite|footcite|smartcite|supercite)\w*)\*?(?:\s*\[[^\]]*\])*\s*\{([^{}]*)$/i
  ) ?? latexArgumentCompletionContext(
    context,
    /\\(?:cites|parencites|textcites|autocites|footcites|smartcites|supercites)\*?(?:\s*\[[^\]]*\])*(?:\s*\{[^{}]*\}(?:\s*\[[^\]]*\])*)+\s*\{([^{}]*)$/i
  );
  if (!argument) return null;
  return currentListItem(argument);
}

function currentListItem(argument: LatexArgumentCompletionContext): LatexArgumentCompletionContext {
  const separator = argument.query.lastIndexOf(",");
  const prefix = argument.query.slice(separator + 1);
  const whitespace = prefix.match(/^\s*/)?.[0].length ?? 0;
  return {
    from: argument.from + separator + 1 + whitespace,
    query: prefix.slice(whitespace)
  };
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
  if (command === "end" || findMatchingLatexEnvironmentEnd(doc, to + closingBrace, name)) {
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
