import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { Annotation, Compartment, EditorState, StateEffect, StateField } from "@codemirror/state";
import {
  Decoration, type DecorationSet, EditorView, keymap, lineNumbers,
  highlightActiveLine, drawSelection, highlightSpecialChars, ViewPlugin, WidgetType
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import {
  bracketMatching, defaultHighlightStyle, foldGutter, foldKeymap,
  foldService, indentOnInput, StreamLanguage, syntaxHighlighting
} from "@codemirror/language";
import {
  autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap,
  snippetCompletion, type Completion, type CompletionContext
} from "@codemirror/autocomplete";
import { getSearchQuery, openSearchPanel, search, searchKeymap, searchPanelOpen } from "@codemirror/search";
import { stex } from "@codemirror/legacy-modes/mode/stex";
import { yCollab, yUndoManagerKeymap } from "y-codemirror.next";
import type * as Y from "yjs";
import type { Awareness } from "y-protocols/awareness";
import type { Comment, LatexCompletionIndex, LatexCompletionItem } from "./types";
import { editorFontStack, type EditorPreferences } from "./editorPreferences";
import { countSearchMatches, searchQuerySignature } from "./editorSearch";

interface Props {
  value: string;
  readOnly: boolean;
  comments: Comment[];
  focusComment: Comment | null;
  preferences: EditorPreferences;
  completionIndex: LatexCompletionIndex | null;
  spellCheckWords: string[];
  spellCheckIssues: SpellCheckIssue[];
  jumpTo: { line: number; column: number; nonce: number } | null;
  searchRequest: number;
  collaboration?: { text: Y.Text; awareness: Awareness };
  onChange: (value: string) => void;
  onSelection: (selectedText: string, startOffset: number, endOffset: number) => void;
  onCommentClick: (commentId: string) => void;
  onCursor: (line: number, column: number) => void;
}

export interface SpellCheckIssue {
  from: number;
  to: number;
  word: string;
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

const setSpellCheckWords = StateEffect.define<string[]>();
const spellCheckExclusions = StateField.define<{ words: string[]; decorations: DecorationSet }>({
  create: (state) => ({ words: [], decorations: buildSpellCheckExclusions(state.doc.toString(), []) }),
  update(value, transaction) {
    let words = value.words;
    for (const effect of transaction.effects) if (effect.is(setSpellCheckWords)) words = effect.value;
    if (transaction.docChanged || words !== value.words) {
      return { words, decorations: buildSpellCheckExclusions(transaction.state.doc.toString(), words) };
    }
    return value;
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.decorations)
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

function completionOptions(t: TFunction) { return [
  snippetCompletion("\\section{${title}}", { label: "\\section", detail: t("completions.section") }),
  snippetCompletion("\\subsection{${title}}", { label: "\\subsection", detail: t("completions.subsection") }),
  snippetCompletion("\\textbf{${text}}", { label: "\\textbf", detail: t("completions.bold") }),
  snippetCompletion("\\emph{${text}}", { label: "\\emph", detail: t("completions.emphasis") }),
  snippetCompletion("\\cite{${key}}", { label: "\\cite", detail: t("completions.citation") }),
  snippetCompletion("\\ref{${label}}", { label: "\\ref", detail: t("completions.reference") }),
  snippetCompletion("\\label{${label}}", { label: "\\label", detail: t("completions.label") }),
  snippetCompletion("\\includegraphics[width=${0.8}\\textwidth]{${file}}", { label: "\\includegraphics", detail: t("completions.image") }),
  snippetCompletion("\\begin{itemize}\n\t\\item ${item}\n\\end{itemize}", { label: "\\begin{itemize}", detail: t("completions.unordered") }),
  snippetCompletion("\\begin{enumerate}\n\t\\item ${item}\n\\end{enumerate}", { label: "\\begin{enumerate}", detail: t("completions.ordered") }),
  snippetCompletion("\\begin{equation}\n\t${equation}\n\\end{equation}", { label: "\\begin{equation}", detail: t("completions.equation") }),
  snippetCompletion("\\begin{figure}[htbp]\n\t\\centering\n\t${content}\n\t\\caption{${caption}}\n\t\\label{fig:${label}}\n\\end{figure}", { label: "\\begin{figure}", detail: t("completions.figure") })
]; }

function localCompletionIndex(content: string): LatexCompletionIndex {
  const commands: LatexCompletionItem[] = [];
  const environments: LatexCompletionItem[] = [];
  const labels: LatexCompletionItem[] = [];
  const citations: LatexCompletionItem[] = [];
  const packages: LatexCompletionItem[] = [];
  const files: LatexCompletionItem[] = [];
  const source = content.split("\n").map((line) => line.replace(/(^|[^\\])%.*$/, "$1")).join("\n");
  const add = (target: LatexCompletionItem[], label: string, detail: string, kind: LatexCompletionItem["kind"]) => {
    if (label && !target.some((entry) => entry.label === label)) target.push({ label, detail, kind, source: "Current file" });
  };
  for (const match of source.matchAll(/\\(?:newcommand|renewcommand|providecommand|DeclareRobustCommand)\s*\*?\s*(?:\{\s*)?\\([A-Za-z@][A-Za-z@0-9:_]*)/g)) add(commands, `\\${match[1]}`, "Project command", "function");
  for (const match of source.matchAll(/\\(?:NewDocumentCommand|RenewDocumentCommand|ProvideDocumentCommand|DeclareDocumentCommand|DeclareExpandableDocumentCommand|RenewExpandableDocumentCommand|ProvideExpandableDocumentCommand)\s*\{\s*\\([A-Za-z@][A-Za-z@0-9:_]*)/g)) add(commands, `\\${match[1]}`, "Project command", "function");
  for (const match of source.matchAll(/\\(?:def|gdef|edef|xdef)\s*\\([A-Za-z@][A-Za-z@0-9:_]*)/g)) add(commands, `\\${match[1]}`, "Project macro", "function");
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

const completionDetailKeys: Record<string, string> = {
  "Project command": "projectCommand", "Project macro": "projectMacro", "Expl3 project command": "expl3Command",
  "Project math operator": "mathOperator", "Project math delimiter": "mathDelimiter", "Project environment": "projectEnvironment",
  "Project file": "projectFile", "Package": "package", "Document class": "documentClass", "Current file": "currentFile", "Project": "project", "LaTeX": "latex"
};

function completionFromItem(entry: LatexCompletionItem, t: TFunction): Completion {
  const detailKey = completionDetailKeys[entry.detail];
  const sourceKey = entry.source ? completionDetailKeys[entry.source] : undefined;
  const detail = detailKey ? t(`completions.${detailKey}`) : entry.source === "LaTeX" ? t("completions.standard") : entry.detail;
  const source = sourceKey ? t(`completions.${sourceKey}`) : entry.source;
  return {
    label: entry.label,
    detail: source ? `${detail} · ${source}` : detail,
    type: entry.kind,
    ...(entry.apply ? { apply: entry.apply } : {}),
    ...(entry.info ? { info: entry.info } : {})
  };
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

function contextCompletion(context: CompletionContext, pattern: RegExp): { from: number; query: string } | null {
  const before = context.state.sliceDoc(0, context.pos);
  const match = before.match(pattern);
  if (!match || match.index === undefined) return null;
  return { from: context.pos - match[1].length, query: match[1] };
}

function latexCompletions(context: CompletionContext, t: TFunction, index: LatexCompletionIndex | null) {
  const local = localCompletionIndex(context.state.doc.toString());
  const command = context.matchBefore(/\\[A-Za-z@0-9:_]*$/);
  if (command || context.explicit) {
    return { from: command?.from ?? context.pos, options: mergeCompletionItems(t, completionOptions(t), index?.commands ?? [], local.commands), validFor: /^\\[A-Za-z@0-9:_]*$/ };
  }
  const environment = contextCompletion(context, /\\(?:begin|end)\{([^{}]*)$/);
  if (environment) return { from: environment.from, options: mergeCompletionItems(t, index?.environments ?? [], local.environments), validFor: /^[A-Za-z0-9*_-]*$/ };
  const label = contextCompletion(context, /\\(?:ref|pageref|autoref|hyperref)\{([^{}]*)$/);
  if (label) return { from: label.from, options: mergeCompletionItems(t, index?.labels ?? [], local.labels), validFor: /^[^{}]*$/ };
  const citation = contextCompletion(context, /\\(?:cite|citep|citet|parencite|textcite|autocite|footcite)(?:\w*)?(?:\[[^]]*\])?\{([^{}]*)$/);
  if (citation) return { from: citation.from, options: mergeCompletionItems(t, index?.citations ?? [], local.citations), validFor: /^[^{}]*$/ };
  const file = contextCompletion(context, /\\(?:input|include|subfile|includegraphics|bibliography|addbibresource)\s*(?:\[[^]]*\])?\{([^{}]*)$/);
  if (file) return { from: file.from, options: mergeCompletionItems(t, index?.files ?? [], local.files), validFor: /^[^{}]*$/ };
  const packageName = contextCompletion(context, /\\(?:usepackage|RequirePackage)\s*(?:\[[^]]*\])?\{([^{}]*)$/);
  if (packageName) return { from: packageName.from, options: mergeCompletionItems(t, index?.packages ?? [], local.packages), validFor: /^[^{}]*$/ };
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
  value, readOnly, comments, focusComment, preferences, completionIndex, jumpTo, searchRequest,
  spellCheckWords, spellCheckIssues, collaboration, onChange, onSelection, onCommentClick, onCursor
}: Props) {
  const { t, i18n } = useTranslation();
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const onSelectionRef = useRef(onSelection);
  const onCommentClickRef = useRef(onCommentClick);
  const onCursorRef = useRef(onCursor);
  const handledSearchRequest = useRef(searchRequest);
  const completionIndexRef = useRef(completionIndex);
  const appearance = useRef(new Compartment());
  onChangeRef.current = onChange;
  onSelectionRef.current = onSelection;
  onCommentClickRef.current = onCommentClick;
  onCursorRef.current = onCursor;
  completionIndexRef.current = completionIndex;

  useEffect(() => {
    if (!host.current) return;
    const state = EditorState.create({
      doc: collaboration?.text.toString() ?? value,
      extensions: [
        lineNumbers(), foldGutter(), ...(collaboration ? [] : [history()]), drawSelection(), highlightActiveLine(), highlightSpecialChars(),
        StreamLanguage.define(stex), syntaxHighlighting(defaultHighlightStyle), bracketMatching(),
        closeBrackets(), indentOnInput(), latexFold, commentMarks, spellCheckExclusions, spellCheckIssueMarks,
        search({ top: true }), searchMatchCount(t), EditorState.phrases.of(searchPhrases(t)),
        autocompletion({ override: [(context) => latexCompletions(context, t, completionIndexRef.current)], activateOnTyping: true }),
        keymap.of([...closeBracketsKeymap, ...completionKeymap, ...searchKeymap, ...foldKeymap,
          ...(collaboration && !readOnly ? yUndoManagerKeymap : []), ...defaultKeymap,
          ...(collaboration ? [] : historyKeymap)]),
        ...(collaboration ? [readOnly
          ? yCollab(collaboration.text, collaboration.awareness, { undoManager: false })
          : yCollab(collaboration.text, collaboration.awareness)] : []),
        EditorState.readOnly.of(readOnly), appearance.current.of(editorAppearance(preferences)),
        EditorView.domEventHandlers({
          click(event) {
            const element = (event.target as HTMLElement).closest<HTMLElement>("[data-comment-id]");
            if (element?.dataset.commentId) onCommentClickRef.current(element.dataset.commentId);
            return false;
          },
          blur() {
            collaboration?.awareness.setLocalStateField("cursor", null);
            return false;
          }
        }),
        EditorView.updateListener.of((update) => {
          const loadedExternalDocument = update.transactions.some(
            (transaction) => transaction.annotation(externalDocumentUpdate)
          );
          if (update.docChanged && !loadedExternalDocument) onChangeRef.current(update.state.doc.toString());
          if (update.selectionSet || update.docChanged) {
            const range = update.state.selection.main;
            onSelectionRef.current(update.state.sliceDoc(range.from, range.to), range.from, range.to);
            const cursorLine = update.state.doc.lineAt(range.head);
            onCursorRef.current(cursorLine.number, range.head - cursorLine.from + 1);
          }
        })
      ]
    });
    view.current = new EditorView({ state, parent: host.current });
    view.current.dispatch({ effects: setCommentMarks.of(toMarks(comments)) });
    return () => {
      view.current?.destroy();
      view.current = null;
    };
  }, [readOnly, i18n.resolvedLanguage, collaboration?.text]);

  useEffect(() => {
    view.current?.dispatch({ effects: appearance.current.reconfigure(editorAppearance(preferences)) });
  }, [preferences]);

  useEffect(() => {
    view.current?.dispatch({ effects: setSpellCheckWords.of(spellCheckWords) });
  }, [spellCheckWords]);

  useEffect(() => {
    const editor = view.current;
    if (!editor) return;
    const currentSource = editor.state.doc.toString();
    const validIssues = spellCheckIssues.filter((issue) => issue.from >= 0 && issue.to <= currentSource.length && issue.to > issue.from);
    editor.dispatch({ effects: setSpellCheckIssues.of(validIssues) });
  }, [spellCheckIssues]);

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
    if (!editor || searchRequest === 0 || searchRequest === handledSearchRequest.current) return;
    handledSearchRequest.current = searchRequest;
    openSearchPanel(editor);
  }, [searchRequest]);

  return <div className="editor-host" ref={host} style={{
    fontFamily: editorFontStack(preferences.font),
    fontSize: `${preferences.fontSize}px`,
    lineHeight: preferences.lineHeight
  }} />;
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

function editorAppearance(preferences: EditorPreferences) {
  return [
    EditorView.contentAttributes.of({
      spellcheck: preferences.spellCheck ? "true" : "false",
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

function balancedLatexArgument(source: string, start: number, open: string, close: string): { from: number; to: number; end: number } | null {
  if (source[start] !== open) return null;
  let depth = 0;
  for (let index = start; index < source.length; index += 1) {
    const escaped = source[index - 1] === "\\" && source[index - 2] !== "\\";
    if (!escaped && source[index] === open) depth += 1;
    if (!escaped && source[index] === close) {
      depth -= 1;
      if (depth === 0) return { from: start, to: index + 1, end: index + 1 };
    }
  }
  return null;
}

function buildSpellCheckExclusions(source: string, words: string[]): DecorationSet {
  const ranges: Array<{ from: number; to: number }> = [];
  const addRange = (from: number, to: number): void => { if (to > from) ranges.push({ from, to }); };
  const addMatches = (pattern: RegExp): void => {
    for (const match of source.matchAll(pattern)) if (match.index !== undefined) addRange(match.index, match.index + match[0].length);
  };
  const tableEnvironments = new Set(["tabular", "tabularx", "tabulary", "longtable", "array", "matrix", "pmatrix", "bmatrix", "Bmatrix", "vmatrix", "Vmatrix"]);
  const optionCommands = new Set(["documentclass", "usepackage", "RequirePackage", "includegraphics", "tikzset", "pgfplotsset", "hypersetup", "lstset", "definecolor", "colorlet", "setlength", "setcounter", "draw", "path", "fill", "filldraw", "shade", "node", "addplot", "color", "textcolor", "colorbox", "pagecolor"]);
  const identifierCommands = new Set(["label", "hypertarget", "ref", "pageref", "autoref", "nameref", "hyperref", "index", "gls", "Gls", "glspl", "Glspl", "cite", "citep", "citet", "citeauthor", "citeyear", "citenum", "parencite", "textcite", "autocite", "footcite"]);
  const optionLike = (value: string) => /[=,!/]/.test(value) || /\b(?:colorbar|legend|width|height|draw|fill|style|domain|samples|anchor|at|axis)\b/.test(value);
  const isIdentifierCommand = (name: string) => identifierCommands.has(name) || /^cite[A-Za-z]*/.test(name);
  const skipWhitespace = (start: number): number => {
    let index = start;
    while (index < source.length && /[ \t\r\n]/.test(source[index])) index += 1;
    return index;
  };
  const commentStart = (position: number): boolean => {
    if (source[position] !== "%") return false;
    let slashes = 0;
    for (let index = position - 1; index >= 0 && source[index] === "\\"; index -= 1) slashes += 1;
    return slashes % 2 === 0;
  };

  for (let index = 0; index < source.length; index += 1) {
    if (commentStart(index)) {
      const end = source.indexOf("\n", index);
      addRange(index, end < 0 ? source.length : end);
      index = end < 0 ? source.length : end;
      continue;
    }
    if (source[index] !== "\\") continue;
    const commandStart = index;
    let commandEnd = index + 1;
    if (/[A-Za-z@]/.test(source[commandEnd] ?? "")) {
      while (commandEnd < source.length && /[A-Za-z@0-9:_]/.test(source[commandEnd])) commandEnd += 1;
    } else if (commandEnd < source.length) commandEnd += 1;
    const name = source.slice(index + 1, commandEnd);
    addRange(commandStart, commandEnd);
    let cursor = skipWhitespace(commandEnd);
    if (name === "begin" || name === "end") {
      const environment = balancedLatexArgument(source, cursor, "{", "}");
      if (environment) {
        addRange(environment.from, environment.to);
        const environmentName = source.slice(environment.from + 1, environment.to - 1).trim();
        cursor = skipWhitespace(environment.end);
        if (name === "begin") {
          const options = balancedLatexArgument(source, cursor, "[", "]");
          if (options) { addRange(options.from, options.to); cursor = skipWhitespace(options.end); }
          if (tableEnvironments.has(environmentName)) {
            const columnSpec = balancedLatexArgument(source, cursor, "{", "}");
            if (columnSpec) addRange(columnSpec.from, columnSpec.to);
          }
        }
      }
      index = commandEnd - 1;
      continue;
    }
    if (isIdentifierCommand(name)) {
      if (source[cursor] === "*") cursor = skipWhitespace(cursor + 1);
      while (true) {
        const argument = balancedLatexArgument(source, cursor, "[", "]") ?? balancedLatexArgument(source, cursor, "{", "}");
        if (!argument) break;
        addRange(argument.from, argument.to);
        cursor = skipWhitespace(argument.end);
      }
    } else {
      const options = balancedLatexArgument(source, cursor, "[", "]");
      if (options && (optionCommands.has(name) || optionLike(source.slice(options.from + 1, options.to - 1)))) {
        addRange(options.from, options.to);
        cursor = skipWhitespace(options.end);
      }
      if (optionCommands.has(name)) {
        const argumentsToSkip = name === "definecolor" || name === "colorlet" ? 3 : 1;
        for (let count = 0; count < argumentsToSkip; count += 1) {
          const argument = balancedLatexArgument(source, cursor, "{", "}");
          if (!argument) break;
          addRange(argument.from, argument.to);
          cursor = skipWhitespace(argument.end);
        }
      }
    }
    index = commandEnd - 1;
  }

  // General fallback for package key=value syntax not directly attached to
  // a command, including multi-word keys and color values.
  for (let equals = source.indexOf("="); equals >= 0; equals = source.indexOf("=", equals + 1)) {
    const delimiters = ["\n", "[", "{", "]", "}", ",", ";"];
    const segmentStart = Math.max(...delimiters.map((delimiter) => source.lastIndexOf(delimiter, equals - 1) + 1));
    const segment = source.slice(segmentStart, equals);
    const key = segment.match(/([A-Za-z][A-Za-z0-9_.:/-]*(?:\s+[A-Za-z][A-Za-z0-9_.:/-]*){0,7})\s*$/);
    if (key?.index !== undefined) addRange(segmentStart + key.index, equals);
    let valueStart = equals + 1;
    while (valueStart < source.length && /\s/.test(source[valueStart])) valueStart += 1;
    let valueEnd = valueStart;
    if (source[valueStart] === "{") {
      const argument = balancedLatexArgument(source, valueStart, "{", "}");
      valueEnd = argument?.end ?? valueStart;
    } else while (valueEnd < source.length && !/[,\]\}\n]/.test(source[valueEnd])) valueEnd += 1;
    addRange(valueStart, valueEnd);
  }
  addMatches(/(?:https?|ftp):\/\/[^\s]+/gi);
  // A leading capital is treated as a title/proper noun and left to the
  // writer; browser spelling dictionaries vary widely on those words.
  addMatches(/\b[A-Z][A-Za-z0-9']*\b/g);
  for (const word of words) {
    if (!word) continue;
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`(^|[^A-Za-z0-9_])(${escaped})(?=$|[^A-Za-z0-9_])`, "gi");
    for (const match of source.matchAll(pattern)) {
      if (match.index === undefined) continue;
      const from = match.index + (match[1]?.length ?? 0);
      ranges.push({ from, to: from + (match[2]?.length ?? 0) });
    }
  }
  ranges.sort((left, right) => left.from - right.from || left.to - right.to);
  const merged: Array<{ from: number; to: number }> = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (previous && range.from <= previous.to) previous.to = Math.max(previous.to, range.to);
    else merged.push({ ...range });
  }
  return Decoration.set(merged.map((range) => Decoration.mark({ attributes: { spellcheck: "false" } }).range(range.from, range.to)), true);
}

function buildSpellCheckIssueDecorations(issues: SpellCheckIssue[], documentLength: number): DecorationSet {
  const ranges = issues
    .map((issue) => ({ from: Math.max(0, Math.min(documentLength, issue.from)), to: Math.max(0, Math.min(documentLength, issue.to)), word: issue.word }))
    .filter((issue) => issue.to > issue.from)
    .sort((left, right) => left.from - right.from || left.to - right.to);
  return Decoration.set(ranges.map((issue) => Decoration.mark({ class: "cm-spell-error", attributes: { title: issue.word } }).range(issue.from, issue.to)), true);
}

function toMarks(comments: Comment[]): CommentMark[] {
  return comments.map((comment) => ({
    id: comment.id, from: comment.startOffset, to: comment.endOffset,
    resolved: comment.resolved, orphaned: comment.orphaned
  }));
}

function buildCommentDecorations(marks: CommentMark[], documentLength: number): DecorationSet {
  const ranges = marks.filter((mark) => !mark.orphaned).map((mark) => {
    const from = Math.max(0, Math.min(documentLength, mark.from));
    const to = Math.max(from, Math.min(documentLength, mark.to));
    const className = `cm-source-comment${mark.resolved ? " cm-source-comment-resolved" : ""}`;
    if (from === to) {
      return Decoration.widget({ widget: new CommentPin(mark.id, className), side: 1 }).range(from);
    }
    return Decoration.mark({ class: className, attributes: { "data-comment-id": mark.id } }).range(from, to);
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
