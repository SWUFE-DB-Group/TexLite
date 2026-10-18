import type { LatexCompletionIndex, LatexCompletionItem, LatexCompletionKind } from "./latexCompletion.js";
import { commandSnippet, newCommandArguments, xparseCommandArguments, xparseCommandDefinitions } from "./latexCommandSnippets.js";
import { maskLatexComments, maskLatexLiteralContent } from "./latexLiterals.js";
import { findLatexReferenceDefinitions } from "./latexReferences.js";

/**
 * Extract source-derived completion symbols without I/O, editor state, caches,
 * built-ins, or project scope. Items have no source attribution: callers add
 * a file path or the current-file marker. Citations here are local bibitems;
 * the server separately indexes BibTeX databases and selects their root scope.
 * This is lexical extraction, not TeX macro expansion.
 */
export function extractLatexSymbols(original: string): LatexCompletionIndex {
  const symbols = {
    commands: new Map<string, LatexCompletionItem>(),
    environments: new Map<string, LatexCompletionItem>(),
    labels: new Map<string, LatexCompletionItem>(),
    citations: new Map<string, LatexCompletionItem>(),
    packages: new Map<string, LatexCompletionItem>(),
    classes: new Map<string, LatexCompletionItem>(),
    files: new Map<string, LatexCompletionItem>()
  };
  const add = (group: keyof LatexCompletionIndex, label: string, detail: string, kind: LatexCompletionKind, apply?: string) => {
    if (label && !symbols[group].has(label)) {
      symbols[group].set(label, { label, detail, kind, ...(apply ? { apply } : {}) });
    }
  };
  const command = (name: string, detail: string, apply?: string) => add("commands", `\\${name}`, detail, "function", apply);
  const commandDetail = (count: number) => `Project command (${count} argument${count === 1 ? "" : "s"})`;
  const environment = (name: string, detail: string) => {
    // Match the editor grammar's EnvName alphabet, including package-defined
    // names such as proof.custom or expl3-style names with a colon.
    if (/^[A-Za-z@0-9:_*.+\-]+$/.test(name)) add("environments", name, detail, "keyword");
  };
  const content = maskLatexComments(maskLatexLiteralContent(original));

  for (const match of content.matchAll(/\\(?:newcommand|renewcommand|providecommand|DeclareRobustCommand)\s*\*?\s*(?:\{\s*)?\\([A-Za-z@][A-Za-z@0-9:_]*)\s*(?:\})?\s*(?:\[(\d+)\])?(?:\s*(\[[^\]]*\]))?/g)) {
    const arguments_ = newCommandArguments(Number.parseInt(match[2] ?? "0", 10), Boolean(match[3]));
    command(match[1], commandDetail(arguments_.length), commandSnippet(`\\${match[1]}`, arguments_));
  }
  for (const definition of xparseCommandDefinitions(content)) {
    const arguments_ = xparseCommandArguments(definition.specification);
    command(definition.name, arguments_ ? commandDetail(arguments_.length) : "Project command",
      arguments_ ? commandSnippet(`\\${definition.name}`, arguments_) : undefined);
  }
  for (const match of content.matchAll(/\\(?:def|gdef|edef|xdef)\s*\\([A-Za-z@][A-Za-z@0-9:_]*)((?:\s*#\d+)*)/g)) {
    const count = [...(match[2] ?? "").matchAll(/#\d+/g)].length;
    command(match[1], "Project macro", commandSnippet(`\\${match[1]}`, newCommandArguments(count, false)));
  }
  for (const match of content.matchAll(/\\DeclareMathOperator\s*\*?\s*\{?\\([A-Za-z@][A-Za-z@0-9:_]*)\}?/g)) command(match[1], "Project math operator");
  for (const match of content.matchAll(/\\DeclarePairedDelimiter\s*\{?\\([A-Za-z@][A-Za-z@0-9:_]*)\}?/g)) command(match[1], "Project math delimiter");
  for (const match of content.matchAll(/\\cs_(?:new|set|gset|provide|generate)(?:_protected)?\:[A-Za-z]+\s+\\([A-Za-z@][A-Za-z@0-9:_]*)/g)) command(match[1], "Expl3 project command");
  for (const match of content.matchAll(/\\(?:newenvironment|renewenvironment|NewDocumentEnvironment|RenewDocumentEnvironment|DeclareDocumentEnvironment)\s*\*?\s*\{([^}]+)\}/g)) environment(match[1].trim(), "Project environment");
  for (const match of content.matchAll(/\\(?:newtheorem|declaretheorem)\s*\*?\s*\{([^}]+)\}/g)) environment(match[1].trim(), "Theorem environment");

  for (const definition of findLatexReferenceDefinitions(original, "label")) {
    add("labels", definition.key, "Label", "constant");
  }
  for (const definition of findLatexReferenceDefinitions(original, "citation")) {
    add("citations", definition.key, "Bibliography key", "constant");
  }
  for (const match of content.matchAll(/\\(?:input|include|subfile|import)\s*(?:\{([^}]+)\}|\s+([^\s%]+))/g)) {
    add("files", (match[1] ?? match[2] ?? "").trim(), "Project file", "text");
  }
  for (const match of content.matchAll(/\\(usepackage|RequirePackage|documentclass)\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}/g)) {
    const isClass = match[1] === "documentclass";
    for (const name of match[2].split(",").map((value) => value.trim()).filter(Boolean)) {
      add(isClass ? "classes" : "packages", name, isClass ? "Document class" : "Package", isClass ? "class" : "text");
    }
  }

  return {
    commands: [...symbols.commands.values()], environments: [...symbols.environments.values()],
    labels: [...symbols.labels.values()], citations: [...symbols.citations.values()],
    packages: [...symbols.packages.values()], classes: [...symbols.classes.values()], files: [...symbols.files.values()]
  };
}
