import type { EditorState } from "@codemirror/state";
import { ensureSyntaxTree, language } from "@codemirror/language";
import type { SyntaxNode, Tree } from "@lezer/common";
import { parser } from "./latex.mjs";
import { classifyLatexReferenceCommand } from "../../shared/latexReferenceCommands";
import { maskLatexComments } from "../../shared/latexLiterals";
import { findLatexCitationCompletion, findLatexLabelCompletion } from "../../shared/latexReferences";
import { isLatexEscaped, readLatexBalancedArgument, skipLatexTrivia } from "../../shared/latexScanner";

export type LatexArgumentKind = "environment" | "citation" | "label" | "file" | "package" | "class";
export interface LatexCursorArgument {
  kind: LatexArgumentKind;
  command: string;
  commandFrom: number;
  from: number;
  query: string;
}
export type LatexCursorRegion = "text" | "math" | "comment" | "literal";
export type LatexCursorContext =
  | { available: false; region: "unknown"; argument: null }
  | { available: true; region: LatexCursorRegion; argument: LatexCursorArgument | null };

// Compatibility scans are confined to an AST-identified command, not the
// document prefix. Oversized/unfinished contexts defer completion safely.
export const MAX_LATEX_CONTEXT_LENGTH = 8_192;
const parseBudgetMs = 5;
const argumentNodes = new Set([
  "EnvNameGroup", "ShortTextArgument", "TextArgument", "MathArgument", "OptionalArgument",
  "Group", "NonEmptyGroup", "DefinitionArgument", "FilePathArgument", "BareFilePathArgument", "UrlArgument"
]);
const mathContainers = new Set(["DollarMath", "ParenMath", "BracketMath"]);
const typedArguments: Readonly<Record<string, LatexArgumentKind>> = {
  EnvNameGroup: "environment", BibKeyArgument: "citation", RefArgument: "label",
  PackageArgument: "package", DocumentClassArgument: "class", FilePathArgument: "file"
};
const commandToken = /^(?:CtrlSeq|Begin|End)$|CtrlSeq$/;

function contextTree(state: EditorState, position: number): Tree | null {
  const activeLanguage = state.facet(language);
  if (!activeLanguage) {
    // Small standalone consumers/tests can use the same grammar. Never
    // manufacture context from a truncated tail with unknown literal state.
    return state.doc.length <= MAX_LATEX_CONTEXT_LENGTH ? parser.parse(state.sliceDoc()) : null;
  }
  if (activeLanguage.name !== "latex") return null;
  // ensureSyntaxTree returns the parse context's latest tree even if the
  // immutable state's tree has not yet been replaced by a view transaction.
  // Already-parsed positions require no additional parsing work.
  return ensureSyntaxTree(state, position, parseBudgetMs);
}

function rawContentClosed(state: EditorState, node: SyntaxNode): boolean {
  if (node.to - node.from > MAX_LATEX_CONTEXT_LENGTH) return false;
  const raw = state.sliceDoc(node.from, node.to);
  if (node.name === "VerbContent") {
    const start = raw.startsWith("*") ? 1 : 0;
    return raw.length > start + 1 && raw.at(-1) === raw[start];
  }
  if (!raw.startsWith("{")) return raw.length > 1 && raw.at(-1) === raw[0];
  // Braced inline literals are raw: '%' is not a TeX comment here.
  let depth = 0;
  for (let index = 0; index < raw.length; index++) {
    if (raw[index] === "\\") { index++; continue; }
    if (raw[index] === "{") depth++;
    if (raw[index] === "}" && --depth === 0) return index === raw.length - 1;
  }
  return false;
}

function regionAt(state: EditorState, position: number, ancestors: readonly SyntaxNode[]): LatexCursorRegion {
  for (const node of ancestors) {
    if (node.name === "Comment" && (position < node.to || state.sliceDoc(node.to - 1, node.to) !== "\n")) return "comment";
    if (["VerbContent", "LstInlineContent"].includes(node.name)
      && (position < node.to || !rawContentClosed(state, node))) return "literal";
    if (node.name === "VerbatimContent") return "literal";
    if (node.name === "VerbatimEnvironment") {
      const end = node.getChild("EndEnv");
      if (!end || position < end.to) {
        const begin = node.getChild("BeginEnv");
        const close = begin?.getChild("EnvNameGroup")?.lastChild;
        if (begin && close?.name === "CloseBrace" && close.from < close.to && position >= begin.to) return "literal";
      }
    }
  }
  for (const node of ancestors) {
    if (node.name === "Math") return "math";
    if (["EquationEnvironment", "EquationArrayEnvironment"].includes(node.name)) {
      const begin = node.getChild("BeginEnv");
      const end = node.getChild("EndEnv");
      if (begin && position >= begin.to && (!end || position <= end.from)) return "math";
    }
    if (mathContainers.has(node.name)) {
      const last = node.lastChild;
      if (position < node.to || !last || last.type.isError) return "math";
    }
  }
  return "text";
}

function commandKind(command: string): LatexArgumentKind | null {
  if (command === "begin" || command === "end") return "environment";
  if (["input", "include", "subfile", "includegraphics", "bibliography", "addbibresource"].includes(command)) return "file";
  if (command === "usepackage" || command === "RequirePackage") return "package";
  if (command === "documentclass") return "class";
  return classifyLatexReferenceCommand(command)?.kind ?? null;
}

function listItem(source: string, start: number): { from: number; query: string } {
  for (let index = start; index < source.length; index++) {
    if (source[index] === "%" && !isLatexEscaped(source, index)) {
      const newline = source.indexOf("\n", index);
      if (newline < 0) break;
      index = newline;
    } else if (source[index] === ",") start = index + 1;
  }
  const from = skipLatexTrivia(source, start);
  return { from, query: source.slice(from) };
}

function unfinishedMandatoryArgument(source: string, start: number, options: boolean): number | null {
  let index = skipLatexTrivia(source, start);
  while (options && source[index] === "[") {
    const argument = readLatexBalancedArgument(source, index, "[", "]");
    if (!argument) return null;
    index = skipLatexTrivia(source, argument.to);
  }
  if (source[index] !== "{" || readLatexBalancedArgument(source, index, "{", "}")) return null;
  // Never replace an outer value while editing a nested group. Comments do
  // not contribute braces, and completed optional arguments were skipped.
  const value = maskLatexComments(source.slice(index + 1));
  for (let cursor = 0; cursor < value.length; cursor++) {
    if (value[cursor] === "\\") { cursor++; continue; }
    if (value[cursor] === "{" || value[cursor] === "}") return null;
  }
  return index + 1;
}

function typedArgumentAt(state: EditorState, position: number, ancestors: readonly SyntaxNode[]): LatexCursorArgument | null {
  for (const node of ancestors) {
    const kind = typedArguments[node.name];
    if (!kind || position - node.from > MAX_LATEX_CONTEXT_LENGTH) continue;
    const owner = ancestors.find((ancestor) => ancestor.from <= node.from
      && ancestor.firstChild && commandToken.test(ancestor.firstChild.name));
    const token = owner?.firstChild;
    if (!token) continue;
    const command = state.sliceDoc(token.from + 1, token.to);
    // The shared classifier remains authoritative, including explicit
    // exclusions for citation configuration commands.
    if (commandKind(command) !== kind) continue;
    const source = state.sliceDoc(node.from, position);
    const start = kind === "citation" || kind === "label"
      ? source.startsWith("{") && !readLatexBalancedArgument(source, 0, "{", "}") ? 1 : null
      : unfinishedMandatoryArgument(source, 0, false);
    if (start === null) continue;
    const result = ["citation", "label", "package"].includes(kind)
      ? listItem(source, start) : { from: start, query: source.slice(start) };
    return { ...result, from: result.from + node.from, command, commandFrom: token.from, kind };
  }
  return null;
}

function argumentAt(state: EditorState, position: number, tree: Tree): LatexCursorArgument | null {
  const commands: Array<{ from: number; to: number; command: string; kind: LatexArgumentKind }> = [];
  const from = Math.max(0, position - MAX_LATEX_CONTEXT_LENGTH);
  tree.iterate({ from, to: position, enter(node) {
    if (node.from < from || node.to > position || !commandToken.test(node.name)) return;
    const command = state.sliceDoc(node.from + 1, node.to);
    const kind = commandKind(command);
    if (kind) commands.push({ from: node.from, to: node.to, command, kind });
  } });
  for (const command of commands.reverse()) {
    const source = state.sliceDoc(command.from, position);
    let result: { from: number; query: string } | null;
    if (command.kind === "citation") result = findLatexCitationCompletion(source);
    else if (command.kind === "label") result = findLatexLabelCompletion(source);
    else {
      const tokenEnd = command.to - command.from + (source[command.to - command.from] === "*" ? 1 : 0);
      const start = unfinishedMandatoryArgument(source, tokenEnd, command.kind !== "environment");
      result = start === null ? null : command.kind === "package" ? listItem(source, start)
        : { from: start, query: source.slice(start) };
    }
    if (result) return { ...result, from: result.from + command.from, kind: command.kind, command: command.command, commandFrom: command.from };
  }
  return null;
}

function followsRecoveredEnvironment(ancestors: readonly SyntaxNode[], position: number): boolean {
  // In a specialized environment, an unfinished end name can be recovered
  // as the next Normal node instead of remaining inside EnvNameGroup. Only
  // that adjacent recovery permits the bounded argument fallback in prose.
  for (const node of ancestors) {
    let previous = node.prevSibling;
    while (previous && ["Whitespace", "NewLine"].includes(previous.name)) previous = previous.prevSibling;
    for (let tail = previous; tail; tail = tail.lastChild) {
      if (tail.name !== "BeginEnv" && tail.name !== "EndEnv") continue;
      const group = tail.getChild("EnvNameGroup");
      const close = group?.lastChild;
      if (group && (!close || close.name !== "CloseBrace" || close.from === close.to)
        && position >= tail.to && position - tail.from <= MAX_LATEX_CONTEXT_LENGTH) return true;
      break;
    }
  }
  return false;
}

/** One cursor-local query for editor features; no source-wide symbol scan. */
export function latexContextAt(state: EditorState, position: number): LatexCursorContext {
  position = Math.max(0, Math.min(position, state.doc.length));
  const tree = contextTree(state, position);
  if (!tree) return { available: false, region: "unknown", argument: null };
  const ancestors: SyntaxNode[] = [];
  for (let node: SyntaxNode | null = tree.resolveInner(position, -1); node; node = node.parent) ancestors.push(node);
  const region = regionAt(state, position, ancestors);
  if (region === "literal" || region === "comment") return { available: true, region, argument: null };
  const argument = typedArgumentAt(state, position, ancestors)
    ?? (ancestors.some((node) => argumentNodes.has(node.name)) || followsRecoveredEnvironment(ancestors, position)
      ? argumentAt(state, position, tree) : null);
  return { available: true, region, argument };
}
