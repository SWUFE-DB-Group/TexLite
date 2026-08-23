import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { Annotation, Compartment, EditorState, Facet, Prec, StateEffect, StateField, Transaction } from "@codemirror/state";
import {
  Decoration, type DecorationSet, EditorView, keymap, lineNumbers,
  highlightActiveLine, drawSelection, highlightSpecialChars, ViewPlugin, WidgetType
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import {
  bracketMatching, defaultHighlightStyle, foldGutter, foldKeymap,
  foldService, indentOnInput, syntaxHighlighting
} from "@codemirror/language";
import {
  autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap,
  pickedCompletion, snippetCompletion, type Completion, type CompletionContext
} from "@codemirror/autocomplete";
import { getSearchQuery, openSearchPanel, search, searchKeymap, searchPanelOpen } from "@codemirror/search";
import { getCM, Vim, vim } from "@replit/codemirror-vim";
import { yCollab, yUndoManagerKeymap } from "y-codemirror.next";
import * as Y from "yjs";
import type { Awareness } from "y-protocols/awareness";
import type { Comment, LatexCompletionIndex, LatexCompletionItem } from "./types";
import { editorFontStack, type EditorPreferences } from "./editorPreferences";
import { countSearchMatches, searchQuerySignature } from "./editorSearch";
import { bibtexLanguage, latexLanguage } from "./latexLanguage";
import { latexAutoPair, latexAutoPairAtCursor } from "./latexAutoPairs";
import type { SpellCheckIssue } from "./spellCheck";
export type { SpellCheckIssue } from "./spellCheck";

interface Props {
  value: string;
  filePath: string;
  readOnly: boolean;
  comments: Comment[];
  focusComment: Comment | null;
  preferences: EditorPreferences;
  nativeSpellCheck: boolean;
  completionIndex: LatexCompletionIndex | null;
  spellCheckIssues: SpellCheckIssue[];
  spellCheckJump: SpellCheckJump | null;
  jumpTo: { line: number; column: number; nonce: number } | null;
  searchRequest: number;
  collaboration?: { text: Y.Text; awareness: Awareness; undoManager?: Y.UndoManager };
  onChange: (value: string) => void;
  onSelection: (selectedText: string, startOffset: number, endOffset: number) => void;
  onCommentClick: (commentId: string) => void;
  onSpellCheckReplace: (issue: SpellCheckIssue, replacement: string) => void;
  onCursor: (line: number, column: number, offset: number) => void;
}

interface SpellSuggestionMenu {
  issue: SpellCheckIssue;
  left: number;
  top: number;
}

export interface SpellCheckJump {
  from: number;
  to: number;
  nonce: number;
}

interface CommentMark {
  id: string;
  from: number;
  to: number;
  resolved: boolean;
  orphaned: boolean;
}

const setCommentMarks = StateEffect.define<CommentMark[]>();
const externalDocumentUpdate = Annotation.define<boolean>();

interface VimHistoryCommands {
  undo: () => boolean;
  redo: () => boolean;
}

const noVimHistoryCommands: VimHistoryCommands = { undo: () => false, redo: () => false };
const vimHistoryCommands = Facet.define<VimHistoryCommands, VimHistoryCommands>({
  combine: (values) => values.at(-1) ?? noVimHistoryCommands
});

Vim.defineAction("texliteUndo", (cm) => {
  if (!cm.cm6.state.facet(vimHistoryCommands).undo()) cm.execCommand("undo");
});
Vim.defineAction("texliteRedo", (cm) => {
  if (!cm.cm6.state.facet(vimHistoryCommands).redo()) cm.execCommand("redo");
});
Vim.mapCommand("u", "action", "texliteUndo", {}, { context: "normal" });
Vim.mapCommand("<C-r>", "action", "texliteRedo", {}, { context: "normal" });

const commentMarks = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, transaction) {
    let mapped = value.map(transaction.changes);
    for (const effect of transaction.effects) {
      if (effect.is(setCommentMarks)) mapped = buildCommentDecorations(effect.value, transaction.state.doc.length);
    }
    return mapped;
  },
  provide: (field) => EditorView.decorations.from(field)
});

const setSpellCheckIssues = StateEffect.define<SpellCheckIssue[]>();
const spellCheckIssueMarks = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, transaction) {
    let mapped = value.map(transaction.changes);
    if (transaction.docChanged) mapped = Decoration.none;
    for (const effect of transaction.effects) {
      if (effect.is(setSpellCheckIssues)) mapped = buildSpellCheckIssueDecorations(effect.value, transaction.state.doc.length);
    }
    return mapped;
  },
  provide: (field) => EditorView.decorations.from(field)
});

const setActiveSpellCheckIssue = StateEffect.define<{ from: number; to: number } | null>();
const activeSpellCheckMark = Decoration.mark({ class: "cm-spell-error-active" });
const activeSpellCheckIssueMarks = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, transaction) {
    let mapped = value.map(transaction.changes);
    if (transaction.docChanged) mapped = Decoration.none;
    for (const effect of transaction.effects) {
      if (!effect.is(setActiveSpellCheckIssue)) continue;
      const issue = effect.value;
      mapped = issue && issue.to > issue.from
        ? Decoration.set([activeSpellCheckMark.range(issue.from, issue.to)])
        : Decoration.none;
    }
    return mapped;
  },
  provide: (field) => EditorView.decorations.from(field)
});

const fallbackCommandLabels = [
  "\\noindent", "\\indent", "\\par", "\\leavevmode", "\\newline", "\\linebreak", "\\nolinebreak", "\\pagebreak", "\\nopagebreak", "\\newpage", "\\clearpage", "\\cleardoublepage",
  "\\smallskip", "\\medskip", "\\bigskip", "\\smallbreak", "\\medbreak", "\\bigbreak", "\\hfill", "\\hfil", "\\vfill", "\\vfil", "\\thinspace", "\\negthinspace", "\\quad", "\\qquad", "\\enspace", "\\enskip", "\\,", "\\:", "\\;", "\\!",
  "\\centering", "\\raggedright", "\\raggedleft", "\\raggedbottom", "\\flushbottom", "\\maketitle", "\\tableofcontents", "\\listoffigures", "\\listoftables", "\\appendix",
  "\\bfseries", "\\mdseries", "\\rmfamily", "\\sffamily", "\\ttfamily", "\\upshape", "\\itshape", "\\slshape", "\\scshape", "\\normalfont", "\\tiny", "\\scriptsize", "\\footnotesize", "\\small", "\\normalsize", "\\large", "\\Large", "\\LARGE", "\\huge", "\\Huge",
  "\\displaystyle", "\\textstyle", "\\scriptstyle", "\\scriptscriptstyle", "\\limits", "\\nolimits", "\\sum", "\\prod", "\\coprod", "\\int", "\\iint", "\\iiint", "\\oint", "\\bigcap", "\\bigcup", "\\bigvee", "\\bigwedge",
  "\\lim", "\\limsup", "\\liminf", "\\sin", "\\cos", "\\tan", "\\cot", "\\log", "\\ln", "\\exp", "\\max", "\\min", "\\sup", "\\inf", "\\det", "\\dim", "\\gcd", "\\ker", "\\Pr",
  "\\ldots", "\\cdots", "\\vdots", "\\ddots", "\\dotsb", "\\dotsc", "\\dotsm", "\\dotso", "\\alpha", "\\beta", "\\gamma", "\\delta", "\\epsilon", "\\varepsilon", "\\theta", "\\vartheta", "\\lambda", "\\mu", "\\pi", "\\varpi", "\\rho", "\\sigma", "\\tau", "\\phi", "\\varphi", "\\omega", "\\Gamma", "\\Delta", "\\Theta", "\\Lambda", "\\Xi", "\\Pi", "\\Sigma", "\\Upsilon", "\\Phi", "\\Psi", "\\Omega",
  "\\pm", "\\mp", "\\times", "\\div", "\\cdot", "\\leq", "\\geq", "\\neq", "\\approx", "\\equiv", "\\sim", "\\simeq", "\\propto", "\\in", "\\notin", "\\subset", "\\subseteq", "\\supset", "\\supseteq", "\\cup", "\\cap", "\\emptyset", "\\varnothing", "\\forall", "\\exists", "\\nexists", "\\infty", "\\partial", "\\nabla", "\\angle", "\\parallel", "\\perp", "\\mid",
  "\\LaTeX", "\\TeX", "\\today", "\\protect", "\\nocite", "\\footnotemark", "\\hrule", "\\verb", "\\verb*"
];

function completionOptions() { return [
  ...fallbackCommandLabels.map((label) => ({ label, type: "keyword" as const })),
  snippetCompletion("\\section{${title}}", { label: "\\section" }),
  snippetCompletion("\\subsection{${title}}", { label: "\\subsection" }),
  snippetCompletion("\\textbf{${text}}", { label: "\\textbf" }),
  snippetCompletion("\\emph{${text}}", { label: "\\emph" }),
  snippetCompletion("\\cite{${key}}", { label: "\\cite" }),
  snippetCompletion("\\ref{${label}}", { label: "\\ref" }),
  snippetCompletion("\\label{${label}}", { label: "\\label" }),
  snippetCompletion("\\includegraphics[width=${0.8}\\textwidth]{${file}}", { label: "\\includegraphics" }),
  snippetCompletion("\\begin{itemize}\n\t\\item ${item}\n\\end{itemize}", { label: "\\begin{itemize}" }),
  snippetCompletion("\\begin{enumerate}\n\t\\item ${item}\n\\end{enumerate}", { label: "\\begin{enumerate}" }),
  snippetCompletion("\\begin{equation}\n\t${equation}\n\\end{equation}", { label: "\\begin{equation}" }),
  snippetCompletion("\\begin{figure}[htbp]\n\t\\centering\n\t${content}\n\t\\caption{${caption}}\n\t\\label{fig:${label}}\n\\end{figure}", { label: "\\begin{figure}" })
]; }

function localCompletionIndex(content: string): LatexCompletionIndex {
  const commands: LatexCompletionItem[] = [];
  const environments: LatexCompletionItem[] = [];
  const labels: LatexCompletionItem[] = [];
  const citations: LatexCompletionItem[] = [];
  const packages: LatexCompletionItem[] = [];
  const files: LatexCompletionItem[] = [];
  const source = content.split("\n").map((line) => line.replace(/(^|[^\\])%.*$/, "$1")).join("\n");
  const commandSnippet = (name: string, argumentCount: number): string | undefined => {
    if (argumentCount <= 0) return undefined;
    const placeholder = (index: number) => `\${${index}}`;
    return name + Array.from({ length: argumentCount }, (_, index) => `{${placeholder(index + 1)}}`).join("");
  };
  const xparseArgumentCount = (specification: string): number => [...specification.matchAll(/[moOrRdDsStvb]/g)].length;
  const add = (target: LatexCompletionItem[], label: string, detail: string, kind: LatexCompletionItem["kind"], apply?: string) => {
    if (label && !target.some((entry) => entry.label === label)) target.push({ label, detail, kind, source: "Current file", ...(apply ? { apply } : {}) });
  };
  for (const match of source.matchAll(/\\(?:newcommand|renewcommand|providecommand|DeclareRobustCommand)\s*\*?\s*(?:\{\s*)?\\([A-Za-z@][A-Za-z@0-9:_]*)\s*(?:\})?\s*(?:\[(\d+)\])?/g)) {
    const args = Number.parseInt(match[2] ?? "0", 10);
    add(commands, `\\${match[1]}`, "Project command", "function", commandSnippet(`\\${match[1]}`, args));
  }
  for (const match of source.matchAll(/\\(?:NewDocumentCommand|RenewDocumentCommand|ProvideDocumentCommand|DeclareDocumentCommand|DeclareExpandableDocumentCommand|RenewExpandableDocumentCommand|ProvideExpandableDocumentCommand)\s*\{\s*\\([A-Za-z@][A-Za-z@0-9:_]*)\s*\}\s*\{([^}]*)\}/g)) {
    const args = xparseArgumentCount(match[2]);
    add(commands, `\\${match[1]}`, "Project command", "function", commandSnippet(`\\${match[1]}`, args));
  }
  for (const match of source.matchAll(/\\(?:def|gdef|edef|xdef)\s*\\([A-Za-z@][A-Za-z@0-9:_]*)((?:\s*#\d+)*)/g)) {
    const args = [...(match[2] ?? "").matchAll(/#\d+/g)].length;
    add(commands, `\\${match[1]}`, "Project macro", "function", commandSnippet(`\\${match[1]}`, args));
  }
  for (const match of source.matchAll(/\\DeclarePairedDelimiter\s*\{?\\([A-Za-z@][A-Za-z@0-9:_]*)\}?/g)) add(commands, `\\${match[1]}`, "Project math delimiter", "function");
  for (const match of source.matchAll(/\\cs_(?:new|set|gset|provide|generate)(?:_protected)?\:[A-Za-z]+\s+\\([A-Za-z@][A-Za-z@0-9:_]*)/g)) add(commands, `\\${match[1]}`, "Expl3 project command", "function");
  for (const match of source.matchAll(/\\(?:newenvironment|renewenvironment|NewDocumentEnvironment|RenewDocumentEnvironment|DeclareDocumentEnvironment)\s*\*?\s*\{([^}]+)\}/g)) add(environments, match[1].trim(), "Project environment", "keyword");
  for (const match of source.matchAll(/\\(?:label|hypertarget)\s*\{([^}]+)\}/g)) add(labels, match[1].trim(), "Label", "constant");
  for (const match of source.matchAll(/\\(?:usepackage|RequirePackage)\s*(?:\[[^]]*\])?\s*\{([^}]+)\}/g)) {
    for (const packageName of match[1].split(",")) add(packages, packageName.trim(), "Package", "text");
  }
  for (const match of source.matchAll(/\\(?:input|include|subfile)\s*(?:\{([^}]+)\}|\s+([^\s%]+))/g)) add(files, (match[1] ?? match[2] ?? "").trim(), "Project file", "text");
  for (const match of source.matchAll(/\\(?:cite|citep|citet|parencite|textcite|autocite|footcite)(?:\w*)?\s*(?:\[[^]]*\])?\s*\{([^}]+)\}/g)) {
    for (const key of match[1].split(",")) add(citations, key.trim(), "Citation key", "constant");
  }
  return { commands, environments, labels, citations, packages, files };
}

const localCompletionCache = new WeakMap<object, LatexCompletionIndex>();

function localCompletionIndexForDocument(context: CompletionContext): LatexCompletionIndex {
  const document = context.state.doc as unknown as object;
  const cached = localCompletionCache.get(document);
  if (cached) return cached;
  const index = localCompletionIndex(context.state.doc.toString());
  localCompletionCache.set(document, index);
  return index;
}

const completionDetailKeys: Record<string, string> = {
  "Project command": "projectCommand", "Project macro": "projectMacro", "Expl3 project command": "expl3Command",
  "Project math operator": "mathOperator", "Project math delimiter": "mathDelimiter", "Project environment": "projectEnvironment",
  "Project file": "projectFile", "Package": "package", "Document class": "documentClass", "Current file": "currentFile", "Project": "project", "LaTeX": "latex"
};

function completionFromItem(entry: LatexCompletionItem, t: TFunction, useSnippet = true): Completion {
  const detailKey = completionDetailKeys[entry.detail];
  const sourceKey = entry.source ? completionDetailKeys[entry.source] : undefined;
  const argumentDetail = entry.detail.match(/^Project command \((\d+) arguments?\)$/);
  const detail = entry.source === "LaTeX" ? "" : argumentDetail
    ? t("completions.projectCommandArgs", { count: Number(argumentDetail[1]) })
    : detailKey ? t(`completions.${detailKey}`) : entry.source === "LaTeX" ? t("completions.standard") : entry.detail;
  const source = entry.source === "LaTeX" ? "" : sourceKey ? t(`completions.${sourceKey}`) : entry.source;
  const completionDetail = source && detail ? `${detail} · ${source}` : detail || source || undefined;
  const completion: Completion = {
    label: entry.label,
    type: entry.kind,
    ...(completionDetail ? { detail: completionDetail } : {}),
    ...(entry.info ? { info: entry.info } : {})
  };
  return useSnippet && entry.apply ? snippetCompletion(entry.apply, completion) : completion;
}

function mergeCompletionItems(t: TFunction, ...groups: Array<LatexCompletionItem[] | Completion[]>): Completion[] {
  const result: Completion[] = [];
  const seen = new Set<string>();
  for (const group of groups) for (const entry of group) {
    const completion = "kind" in entry ? completionFromItem(entry, t) : entry;
    if (!seen.has(completion.label)) {
      seen.add(completion.label);
      result.push(completion);
    }
  }
  return result;
}

function withoutCompletionDetails(items: Completion[]): Completion[] {
  return items.map(({ detail: _detail, ...item }) => item);
}

function withoutSnippets(items: LatexCompletionItem[]): LatexCompletionItem[] {
  return items.map(({ apply: _apply, ...item }) => item);
}

function contextCompletion(context: CompletionContext, pattern: RegExp): { from: number; query: string } | null {
  const before = context.state.sliceDoc(0, context.pos);
  const match = before.match(pattern);
  if (!match || match.index === undefined) return null;
  return { from: context.pos - match[1].length, query: match[1] };
}

function environmentCompletionContext(context: CompletionContext): { from: number; query: string; command: "begin" | "end" } | null {
  const before = context.state.sliceDoc(0, context.pos);
  const match = before.match(/\\(begin|end)\{([^{}]*)$/);
  if (!match || match.index === undefined) return null;
  return { from: context.pos - match[2].length, query: match[2], command: match[1] as "begin" | "end" };
}

function isLatexComment(context: CompletionContext): boolean {
  const line = context.state.doc.lineAt(context.pos);
  let backslashes = 0;
  for (let index = 0; index < context.pos - line.from; index += 1) {
    const character = line.text[index];
    if (character === "\\") {
      backslashes += 1;
      continue;
    }
    if (character === "%" && backslashes % 2 === 0) return true;
    backslashes = 0;
  }
  return false;
}

function environmentCompletion(entry: Completion): Completion {
  return {
    ...entry,
    apply(view, completion, from, to) {
      const line = view.state.doc.lineAt(from);
      const indent = line.text.match(/^\s*/)?.[0] ?? "";
      const name = completion.label;
      const insert = name + "}\n" + indent + "\t\n" + indent + "\\end{" + name + "}";
      const cursor = from + name.length + 1 + 1 + indent.length + 1;
      const closingBrace = view.state.sliceDoc(to, to + 1) === "}" ? 1 : 0;
      view.dispatch({
        changes: { from, to: to + closingBrace, insert },
        selection: { anchor: cursor },
        annotations: [pickedCompletion.of(completion), Transaction.userEvent.of("input.complete")]
      });
    }
  };
}

function latexAutoPairInput(view: EditorView, from: number, to: number, text: string, insert: () => Transaction): boolean {
  const pair = latexAutoPair(view.state.doc.toString(), from, to, text);
  if (!pair) return false;
  view.dispatch(insert());
  const cursor = from + text.length;
  view.dispatch({
    changes: { from: cursor, insert: pair.insert },
    selection: { anchor: cursor + pair.cursorOffset },
    annotations: Transaction.userEvent.of("input.complete")
  });
  return true;
}

function latexCompletions(context: CompletionContext, t: TFunction, index: LatexCompletionIndex | null) {
  if (isLatexComment(context)) return null;
  const local = localCompletionIndexForDocument(context);
  const command = context.matchBefore(/\\(?:[A-Za-z@0-9:_]*(?:\*)?|[,;!:])$/);
  if (command || context.explicit) {
    return { from: command?.from ?? context.pos, options: withoutCompletionDetails(mergeCompletionItems(t, local.commands, index?.commands ?? [], completionOptions())), validFor: /^\\(?:[A-Za-z@0-9:_]*(?:\*)?|[,;!:])$/ };
  }
  const environment = environmentCompletionContext(context);
  if (environment) {
    const options = mergeCompletionItems(t, withoutSnippets(local.environments), withoutSnippets(index?.environments ?? []));
    return {
      from: environment.from,
      options: withoutCompletionDetails(environment.command === "begin" ? options.map(environmentCompletion) : options),
      validFor: /^[A-Za-z0-9*:_-]*$/
    };
  }
  const label = contextCompletion(context, /\\(?:ref|pageref|autoref|nameref|cref|Cref|eqref|vref)\s*(?:\[[^]]*\])?\{([^{}]*)$/)
    ?? contextCompletion(context, /\\hyperref\[([^\[\]]*)$/);
  if (label) return { from: label.from, options: mergeCompletionItems(t, local.labels, index?.labels ?? []), validFor: /^[^{}]*$/ };
  const citation = contextCompletion(context, /\\(?:cite|citep|citet|parencite|textcite|autocite|footcite)(?:\w*)?(?:\[[^]]*\])?\{([^{}]*)$/);
  if (citation) return { from: citation.from, options: mergeCompletionItems(t, local.citations, index?.citations ?? []), validFor: /^[^{}]*$/ };
  const file = contextCompletion(context, /\\(?:input|include|subfile|includegraphics|bibliography|addbibresource)\s*(?:\[[^]]*\])?\{([^{}]*)$/);
  if (file) return { from: file.from, options: mergeCompletionItems(t, local.files, index?.files ?? []), validFor: /^[^{}]*$/ };
  const packageName = contextCompletion(context, /\\(?:usepackage|RequirePackage)\s*(?:\[[^]]*\])?\{([^{}]*)$/);
  if (packageName) return { from: packageName.from, options: mergeCompletionItems(t, local.packages, index?.packages ?? []), validFor: /^[^{}]*$/ };
  const documentClass = contextCompletion(context, /\\documentclass\s*(?:\[[^]]*\])?\{([^{}]*)$/);
  if (documentClass) return { from: documentClass.from, options: mergeCompletionItems(t, index?.files ?? []), validFor: /^[^{}]*$/ };
  return null;
}

const latexFold = foldService.of((state, lineStart) => {
  const line = state.doc.lineAt(lineStart);
  const begin = line.text.match(/\\begin\{([^}]+)\}/);
  if (begin) {
    let depth = 1;
    for (let number = line.number + 1; number <= state.doc.lines; number += 1) {
      const candidate = state.doc.line(number);
      const escaped = begin[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      depth += (candidate.text.match(new RegExp(`\\\\begin\\{${escaped}\\}`, "g")) ?? []).length;
      depth -= (candidate.text.match(new RegExp(`\\\\end\\{${escaped}\\}`, "g")) ?? []).length;
      if (depth === 0 && candidate.from > line.to) return { from: line.to, to: candidate.from };
    }
  }
  const section = line.text.match(/^\s*\\(part|chapter|section|subsection|subsubsection)\*?/);
  if (section) {
    const levels: Record<string, number> = { part: 0, chapter: 0, section: 1, subsection: 2, subsubsection: 3 };
    const level = levels[section[1]];
    for (let number = line.number + 1; number <= state.doc.lines; number += 1) {
      const candidate = state.doc.line(number);
      const next = candidate.text.match(/^\s*\\(part|chapter|section|subsection|subsubsection)\*?/);
      if (next && levels[next[1]] <= level) return { from: line.to, to: Math.max(line.to, candidate.from - 1) };
    }
    if (line.to < state.doc.length) return { from: line.to, to: state.doc.length };
  }
  return null;
});

export function LatexEditor({
  value, filePath, readOnly, comments, focusComment, preferences, completionIndex, jumpTo, searchRequest,
  nativeSpellCheck, spellCheckIssues, spellCheckJump, collaboration, onChange, onSelection, onCommentClick, onSpellCheckReplace, onCursor
}: Props) {
  const { t, i18n } = useTranslation();
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const onSelectionRef = useRef(onSelection);
  const onCommentClickRef = useRef(onCommentClick);
  const onSpellCheckReplaceRef = useRef(onSpellCheckReplace);
  const onCursorRef = useRef(onCursor);
  const spellCheckIssuesRef = useRef(spellCheckIssues);
  const handledSearchRequest = useRef(searchRequest);
  const completionIndexRef = useRef(completionIndex);
  const appearance = useRef(new Compartment());
  const vimMode = useRef(new Compartment());
  const vimStatusCleanup = useRef<(() => void) | null>(null);
  const [vimStatus, setVimStatus] = useState(preferences.vimMode ? "NORMAL" : "");
  const [spellSuggestionMenu, setSpellSuggestionMenu] = useState<SpellSuggestionMenu | null>(null);
  onChangeRef.current = onChange;
  onSelectionRef.current = onSelection;
  onCommentClickRef.current = onCommentClick;
  onSpellCheckReplaceRef.current = onSpellCheckReplace;
  onCursorRef.current = onCursor;
  spellCheckIssuesRef.current = spellCheckIssues;
  completionIndexRef.current = completionIndex;

  const syncVimStatus = (editor: EditorView, enabled: boolean) => {
    vimStatusCleanup.current?.();
    vimStatusCleanup.current = null;
    if (!enabled) {
      setVimStatus("");
      return;
    }
    const cm = getCM(editor);
    if (!cm) {
      setVimStatus("NORMAL");
      return;
    }
    const update = () => {
      const mode = cm.state.vim?.mode ?? (cm.state.vim?.insertMode ? "insert" : "normal");
      setVimStatus(mode.toUpperCase());
    };
    update();
    cm.on("vim-mode-change", update);
    vimStatusCleanup.current = () => cm.off("vim-mode-change", update);
  };

  useEffect(() => {
    if (!host.current) return;
    const collaborationUndoManager = collaboration && !readOnly ? collaboration.undoManager ?? null : null;
    const state = EditorState.create({
      doc: collaboration?.text.toString() ?? value,
      extensions: [
        lineNumbers(), foldGutter(), ...(collaboration ? [] : [history()]), drawSelection(), highlightActiveLine(), highlightSpecialChars(),
        /\.bib$/i.test(filePath) ? bibtexLanguage : latexLanguage, syntaxHighlighting(defaultHighlightStyle), bracketMatching(),
        Prec.high(EditorView.inputHandler.of(latexAutoPairInput)), closeBrackets(), indentOnInput(), latexFold, commentMarks, spellCheckIssueMarks, activeSpellCheckIssueMarks,
        search({ top: false }), searchMatchCount(t), EditorState.phrases.of(searchPhrases(t)),
        autocompletion({ override: [(context) => latexCompletions(context, t, completionIndexRef.current)], activateOnTyping: true }),
        ...(collaborationUndoManager ? [vimHistoryCommands.of({
          undo: () => collaborationUndoManager.undo() !== null,
          redo: () => collaborationUndoManager.redo() !== null
        })] : []),
        vimMode.current.of(preferences.vimMode ? vim() : []),
        keymap.of([...closeBracketsKeymap, ...completionKeymap, ...searchKeymap, ...foldKeymap,
          ...(collaboration && !readOnly ? yUndoManagerKeymap : []), ...defaultKeymap,
          ...(collaboration ? [] : historyKeymap)]),
        ...(collaboration ? [yCollab(collaboration.text, collaboration.awareness, { undoManager: collaborationUndoManager ?? false })] : []),
        EditorState.readOnly.of(readOnly), appearance.current.of(editorAppearance(preferences, nativeSpellCheck)),
        EditorView.domEventHandlers({
          click(event) {
            const element = (event.target as HTMLElement).closest<HTMLElement>("[data-comment-id]");
            if (element?.dataset.commentId) onCommentClickRef.current(element.dataset.commentId);
            return false;
          },
          contextmenu(event) {
            const element = (event.target as HTMLElement).closest<HTMLElement>("[data-spell-error]");
            if (!element) return false;
            const from = Number(element.dataset.spellFrom);
            const to = Number(element.dataset.spellTo);
            const issue = spellCheckIssuesRef.current.find((candidate) => candidate.from === from && candidate.to === to);
            if (!issue) return false;
            event.preventDefault();
            const width = 250;
            const height = Math.min(300, 100 + issue.suggestions.length * 34);
            setSpellSuggestionMenu({
              issue,
              left: Math.max(8, Math.min(event.clientX, window.innerWidth - width - 8)),
              top: Math.max(8, Math.min(event.clientY, window.innerHeight - height - 8))
            });
            return true;
          },
          blur(_event, editor) {
            const range = editor.state.selection.main;
            onSelectionRef.current(editor.state.sliceDoc(range.from, range.to), range.from, range.to);
            collaboration?.awareness.setLocalStateField("cursor", null);
            return false;
          }
        }),
        EditorView.updateListener.of((update) => {
          const loadedExternalDocument = update.transactions.some(
            (transaction) => transaction.annotation(externalDocumentUpdate)
          );
          if (update.docChanged && !loadedExternalDocument) onChangeRef.current(update.state.doc.toString());
          if (update.docChanged) setSpellSuggestionMenu(null);
          if (update.selectionSet && !update.docChanged && update.transactions.some((transaction) => transaction.isUserEvent("input"))) {
            const cursor = update.state.selection.main.head;
            const pair = latexAutoPairAtCursor(update.state.doc.toString(), cursor);
            if (pair) update.view.dispatch({
              changes: { from: cursor, insert: pair.insert },
              selection: { anchor: cursor + pair.cursorOffset },
              annotations: Transaction.userEvent.of("input.complete")
            });
          }
          if (update.selectionSet || update.docChanged) {
            const range = update.state.selection.main;
            onSelectionRef.current(update.state.sliceDoc(range.from, range.to), range.from, range.to);
            const cursorLine = update.state.doc.lineAt(range.head);
            onCursorRef.current(cursorLine.number, range.head - cursorLine.from + 1, range.head);
          }
        })
      ]
    });
    view.current = new EditorView({ state, parent: host.current });
    syncVimStatus(view.current, preferences.vimMode);
    view.current.dispatch({ effects: setCommentMarks.of(toMarks(comments)) });
    return () => {
      vimStatusCleanup.current?.();
      vimStatusCleanup.current = null;
      view.current?.destroy();
      view.current = null;
    };
  }, [filePath, readOnly, i18n.resolvedLanguage, collaboration?.text]);

  useEffect(() => {
    const editor = view.current;
    if (!editor) return;
    editor.dispatch({ effects: [
      appearance.current.reconfigure(editorAppearance(preferences, nativeSpellCheck)),
      vimMode.current.reconfigure(preferences.vimMode ? vim() : [])
    ] });
    syncVimStatus(editor, preferences.vimMode);
  }, [preferences, nativeSpellCheck]);

  useEffect(() => {
    const editor = view.current;
    if (!editor) return;
    const currentSource = editor.state.doc.toString();
    const validIssues = spellCheckIssues.filter((issue) => issue.from >= 0 && issue.to <= currentSource.length && issue.to > issue.from);
    editor.dispatch({ effects: [setSpellCheckIssues.of(validIssues), setActiveSpellCheckIssue.of(null)] });
  }, [spellCheckIssues]);

  useEffect(() => {
    setSpellSuggestionMenu(null);
  }, [spellCheckIssues]);

  useEffect(() => {
    if (!spellSuggestionMenu) return;
    const closeOnOutsideClick = (event: MouseEvent) => {
      if (event.target instanceof Element && event.target.closest(".spell-suggestions-menu")) return;
      setSpellSuggestionMenu(null);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSpellSuggestionMenu(null);
    };
    document.addEventListener("mousedown", closeOnOutsideClick, true);
    document.addEventListener("keydown", closeOnEscape, true);
    return () => {
      document.removeEventListener("mousedown", closeOnOutsideClick, true);
      document.removeEventListener("keydown", closeOnEscape, true);
    };
  }, [spellSuggestionMenu]);

  useEffect(() => {
    const editor = view.current;
    if (collaboration || !editor || editor.state.doc.toString() === value) return;
    editor.dispatch({
      changes: { from: 0, to: editor.state.doc.length, insert: value },
      annotations: externalDocumentUpdate.of(true)
    });
  }, [value, collaboration]);

  useEffect(() => {
    view.current?.dispatch({ effects: setCommentMarks.of(toMarks(comments)) });
  }, [comments]);

  useEffect(() => {
    const editor = view.current;
    if (!editor || !focusComment || focusComment.orphaned) return;
    const from = Math.min(focusComment.startOffset, editor.state.doc.length);
    const to = Math.min(Math.max(from, focusComment.endOffset), editor.state.doc.length);
    editor.dispatch({ selection: { anchor: from, head: to }, effects: EditorView.scrollIntoView(from, { y: "center" }) });
    editor.focus();
  }, [focusComment]);

  useEffect(() => {
    const editor = view.current;
    if (!editor || !jumpTo) return;
    const lineNumber = Math.max(1, Math.min(editor.state.doc.lines, jumpTo.line));
    const line = editor.state.doc.line(lineNumber);
    const position = Math.min(line.to, line.from + Math.max(0, jumpTo.column - 1));
    editor.dispatch({
      selection: { anchor: line.from, head: line.to },
      effects: EditorView.scrollIntoView(position, { y: "center", yMargin: 60 })
    });
    editor.focus();
  }, [jumpTo?.nonce]);

  useEffect(() => {
    const editor = view.current;
    if (!editor || !spellCheckJump) return;
    const from = Math.max(0, Math.min(spellCheckJump.from, editor.state.doc.length));
    const to = Math.max(from, Math.min(spellCheckJump.to, editor.state.doc.length));
    editor.dispatch({
      selection: { anchor: from },
      effects: [
        setActiveSpellCheckIssue.of({ from, to }),
        EditorView.scrollIntoView(from, { y: "center", yMargin: 60 })
      ]
    });
    editor.focus();
  }, [spellCheckJump?.nonce]);

  useEffect(() => {
    const editor = view.current;
    if (!editor || searchRequest === 0 || searchRequest === handledSearchRequest.current) return;
    handledSearchRequest.current = searchRequest;
    openSearchPanel(editor);
  }, [searchRequest]);

  return <div className="editor-shell" style={{
    fontFamily: editorFontStack(preferences.font),
    fontSize: `${preferences.fontSize}px`,
    lineHeight: preferences.lineHeight
  }}>
    <div className="editor-host" ref={host} />
    {spellSuggestionMenu && <div className="spell-suggestions-menu" role="menu" aria-label={t("editor.writingSuggestions")} onMouseDown={(event) => event.stopPropagation()}>
      <div className="spell-suggestions-title">{t("editor.writingSuggestions")}</div>
      {spellSuggestionMenu.issue.message && <div className="spell-suggestions-message">{spellSuggestionMenu.issue.message}</div>}
      {spellSuggestionMenu.issue.suggestions.map((suggestion, index) => <button key={`${suggestion}-${index}`} type="button" role="menuitem" disabled={readOnly} title={readOnly ? t("editor.spellCheckReadOnly") : t("editor.replaceWith", { word: suggestion || t("editor.removeText") })} onClick={() => { onSpellCheckReplaceRef.current(spellSuggestionMenu.issue, suggestion); setSpellSuggestionMenu(null); }}>{suggestion || t("editor.removeText")}</button>)}
      {spellSuggestionMenu.issue.suggestions.length === 0 && <span className="spell-suggestions-empty">{t("editor.noWritingSuggestions")}</span>}
      {readOnly && spellSuggestionMenu.issue.suggestions.length > 0 && <span className="spell-suggestions-readonly">{t("editor.spellCheckReadOnly")}</span>}
    </div>}
    {preferences.vimMode && <div className="vim-editor-status" role="status" aria-live="polite"><span>--{vimStatus || "NORMAL"}--</span></div>}
  </div>;
}

function searchPhrases(t: TFunction): Record<string, string> {
  return {
    "Find": t("editor.search.find"),
    "Replace": t("editor.search.replace"),
    "next": t("editor.search.next"),
    "previous": t("editor.search.previous"),
    "all": t("editor.search.all"),
    "match case": t("editor.search.matchCase"),
    "regexp": t("editor.search.regexp"),
    "by word": t("editor.search.wholeWord"),
    "replace": t("editor.search.replaceNext"),
    "replace all": t("editor.search.replaceAll"),
    "close": t("common.close"),
    "current match": t("editor.search.currentMatch"),
    "on line": t("editor.search.onLine"),
    "replaced match on line $": t("editor.search.replacedMatchOnLine"),
    "replaced $ matches": t("editor.search.replacedMatches"),
    "Go to line": t("editor.search.goToLine"),
    "go": t("editor.search.go")
  };
}

function searchMatchCount(t: TFunction) {
  return ViewPlugin.fromClass(class {
    private frame: number | null = null;
    private document: EditorState["doc"];
    private signature = "";
    private count = 0;

    constructor(private readonly view: EditorView) {
      this.document = view.state.doc;
      this.schedule();
    }

    update(): void {
      this.schedule();
    }

    destroy(): void {
      if (this.frame !== null) cancelAnimationFrame(this.frame);
    }

    private schedule(): void {
      if (this.frame !== null) cancelAnimationFrame(this.frame);
      this.frame = requestAnimationFrame(() => {
        this.frame = null;
        this.render();
      });
    }

    private render(): void {
      if (!searchPanelOpen(this.view.state)) return;
      const panel = this.view.dom.querySelector<HTMLElement>(".cm-panel.cm-search");
      if (!panel) return;
      let status = panel.querySelector<HTMLElement>(".cm-search-count");
      if (!status) {
        status = document.createElement("span");
        status.className = "cm-search-count";
        status.setAttribute("role", "status");
        status.setAttribute("aria-live", "polite");
        const close = panel.querySelector("[name=close]");
        panel.insertBefore(status, close);
      }
      const query = getSearchQuery(this.view.state);
      const signature = searchQuerySignature(query);
      if (this.document !== this.view.state.doc || this.signature !== signature) {
        this.document = this.view.state.doc;
        this.signature = signature;
        this.count = countSearchMatches(this.view.state, query);
      }
      status.textContent = !query.search ? ""
        : !query.valid ? t("editor.search.invalidQuery")
          : this.count === 0 ? t("editor.search.noMatches")
            : t("editor.search.matchCount", { count: this.count });
    }
  });
}

function editorAppearance(preferences: EditorPreferences, nativeSpellCheck: boolean) {
  return [
    EditorView.contentAttributes.of({
      // Harper normally provides syntax-aware server-side checks. If that
      // service fails, enable the browser checker as a lightweight fallback.
      spellcheck: nativeSpellCheck ? "true" : "false",
      autocorrect: "off",
      autocapitalize: "off",
      autocomplete: "off",
      lang: "en-US"
    }),
    EditorView.theme({
      "&": { fontSize: `${preferences.fontSize}px` },
      ".cm-scroller": { fontFamily: "inherit", lineHeight: "inherit" },
      ".cm-content": { fontFamily: "inherit", fontSize: "inherit" },
      ".cm-gutters": { fontFamily: "inherit", fontSize: "inherit" }
    }),
    preferences.lineWrapping ? EditorView.lineWrapping : []
  ];
}

function buildSpellCheckIssueDecorations(issues: SpellCheckIssue[], documentLength: number): DecorationSet {
  const ranges = issues
    .map((issue) => ({ from: Math.max(0, Math.min(documentLength, issue.from)), to: Math.max(0, Math.min(documentLength, issue.to)), word: issue.word, kind: issue.kind, message: issue.message }))
    .filter((issue) => issue.to > issue.from)
    .sort((left, right) => left.from - right.from || left.to - right.to);
  return Decoration.set(ranges.map((issue) => Decoration.mark({
    class: issue.kind === "spelling" ? "cm-spell-error" : "cm-grammar-warning",
    attributes: {
      title: issue.message || issue.word,
      "data-spell-error": "true",
      "data-spell-kind": issue.kind,
      "data-spell-from": String(issue.from),
      "data-spell-to": String(issue.to)
    }
  }).range(issue.from, issue.to)), true);
}

function toMarks(comments: Comment[]): CommentMark[] {
  return comments.map((comment) => ({
    id: comment.id, from: comment.startOffset, to: comment.endOffset,
    resolved: comment.resolved, orphaned: comment.orphaned
  }));
}

function buildCommentDecorations(marks: CommentMark[], documentLength: number): DecorationSet {
  const ranges = marks.filter((mark) => !mark.orphaned).flatMap((mark) => {
    const from = Math.max(0, Math.min(documentLength, mark.from));
    const to = Math.max(from, Math.min(documentLength, mark.to));
    const className = `cm-source-comment${mark.resolved ? " cm-source-comment-resolved" : ""}`;
    if (from === to) {
      return [Decoration.widget({ widget: new CommentPin(mark.id, className), side: 1 }).range(from)];
    }
    return [
      Decoration.mark({ class: className }).range(from, to),
      Decoration.widget({ widget: new CommentPin(mark.id, className), side: 1 }).range(to)
    ];
  });
  return Decoration.set(ranges, true);
}

class CommentPin extends WidgetType {
  constructor(private readonly id: string, private readonly className: string) { super(); }
  toDOM(): HTMLElement {
    const pin = document.createElement("span");
    pin.className = `${this.className} cm-comment-pin`;
    pin.dataset.commentId = this.id;
    pin.textContent = "●";
    return pin;
  }
}
