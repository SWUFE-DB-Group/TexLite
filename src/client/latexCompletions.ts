import type { TFunction } from "i18next";
import { Transaction } from "@codemirror/state";
import { indentUnit } from "@codemirror/language";
import { closeCompletion, currentCompletions, insertCompletionText, pickedCompletion, selectedCompletionIndex, snippetCompletion, type Completion, type CompletionContext } from "@codemirror/autocomplete";
import type { EditorView } from "@codemirror/view";
import type { LatexCompletionIndex, LatexCompletionItem } from "./types";
import { latexCompletionContext, latexEnvironmentCompletionPlan } from "./latexCompletionContexts";
import { isLatexEscaped } from "../shared/latexScanner";
import { extractLatexSymbols } from "../shared/latexSymbols";

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
  const index = extractLatexSymbols(content);
  for (const items of Object.values(index)) {
    for (const item of items) item.source = "Current file";
  }
  return index;
}

function bibtexCitationItems(index: LatexCompletionIndex | null): LatexCompletionItem[] {
  // Only BibTeX entries are project-wide citation candidates. A
  // `\\bibitem` belongs to the file currently open in the editor and is
  // collected locally above; historical `\\cite` uses must never become
  // completion suggestions.
  return (index?.citations ?? []).filter((item) => /\.bib$/i.test(item.source ?? ""));
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
    : detailKey ? t(`completions.${detailKey}`) : entry.detail;
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

function environmentCompletion(entry: Completion, command: "begin" | "end"): Completion {
  return {
    ...entry,
    apply(view, completion, from, to) {
      const name = completion.label;
      const plan = latexEnvironmentCompletionPlan(view.state.doc, from, to, name, command, view.state.facet(indentUnit));
      view.dispatch({
        changes: { from, to: plan.to, insert: plan.insert },
        selection: { anchor: plan.cursor },
        annotations: [pickedCompletion.of(completion), Transaction.userEvent.of("input.complete")]
      });
    }
  };
}

const COMMAND_TAIL = /^[A-Za-z@0-9:_]*\*?/;
const ENVIRONMENT_TAIL = /^[A-Za-z0-9@:*_.+\-]*/;
const LIST_ITEM_TAIL = /^[^,{}%\s]*/;
const ARGUMENT_TAIL = /^[^{}]*/;
const commandsWithSnippets = new WeakSet<Completion>();
const PLAIN_COMMAND = /^\\[A-Za-z@][A-Za-z@0-9:_]*\*?$/;

/** Completing inside an argument replaces the rest of that item, not just its start. */
function replacingTail(option: Completion, tail: RegExp): Completion {
  const original = option.apply;
  return {
    ...option,
    apply(view, completion, from, to) {
      const end = to + (tail.exec(view.state.sliceDoc(to, to + 512))?.[0].length ?? 0);
      if (typeof original === "function") original(view, completion, from, end);
      else view.dispatch({ ...insertCompletionText(view.state, original ?? completion.label, from, end), annotations: pickedCompletion.of(completion) });
    }
  };
}

/**
 * Completing a command already in the source replaces its whole name and keeps
 * its arguments. Text after the cursor that does not form a known command stays:
 * typing \\emph directly before a word must not swallow the word.
 */
function replacingCommand(option: Completion, known: ReadonlySet<string>): Completion {
  const original = option.apply;
  const replacing: Completion = {
    ...option,
    apply(view, completion, from, to) {
      const name = view.state.sliceDoc(from, to);
      const tail = PLAIN_COMMAND.test(name + "x") ? COMMAND_TAIL.exec(view.state.sliceDoc(to, to + 256))?.[0] ?? "" : "";
      const next = view.state.sliceDoc(to + tail.length, to + tail.length + 1);
      const hasArguments = next === "{" || next === "[";
      const end = known.has(name + tail) || hasArguments ? to + tail.length : to;
      if (typeof original === "function" && !(hasArguments && end === to + tail.length && PLAIN_COMMAND.test(completion.label))) {
        original(view, completion, from, end);
      } else {
        view.dispatch({ ...insertCompletionText(view.state, typeof original === "string" ? original : completion.label, from, end), annotations: pickedCompletion.of(completion) });
      }
    }
  };
  if (typeof original === "function") commandsWithSnippets.add(replacing);
  return replacing;
}

/**
 * A fully typed command with nothing to expand has nothing to complete, so
 * Enter closes the list and starts a new line. Returns false to let it through.
 */
export function enterAfterCompleteLatexCommand(view: EditorView): boolean {
  const index = selectedCompletionIndex(view.state);
  const option = index === null ? undefined : currentCompletions(view.state)[index];
  if (!option?.label.startsWith("\\") || commandsWithSnippets.has(option)) return false;
  const head = view.state.selection.main.head;
  if (view.state.sliceDoc(head - option.label.length, head) === option.label) closeCompletion(view);
  return false;
}

const TEX_SOURCE = /\.(?:tex|ltx|tikz|pgf|pdf_tex|inc)$/i;
const BIBLIOGRAPHY = /\.bib$/i;
const fileTypes: Readonly<Record<string, RegExp>> = {
  input: TEX_SOURCE, include: TEX_SOURCE, subfile: TEX_SOURCE, import: TEX_SOURCE, subimport: TEX_SOURCE,
  includegraphics: /\.(?:pdf|png|jpe?g|eps|mps|jbig2|jb2)$/i, includepdf: /\.pdf$/i, includesvg: /\.svg$/i,
  bibliography: BIBLIOGRAPHY, addbibresource: BIBLIOGRAPHY
};
/** A name without an extension is how TeX sources often refer to these files. */
const NO_EXTENSION = /(?:^|\/)[^./]+$/;

function filesForCommand(options: Completion[], command: string, firstArgument: string | undefined): Completion[] {
  const type = fileTypes[command];
  const matching = type ? options.filter((option) => type.test(option.label) || NO_EXTENSION.test(option.label)) : options;
  if (!firstArgument || (command !== "import" && command !== "subimport")) return matching;
  // These take a directory, then a file named relative to it.
  const base = firstArgument.trim().replace(/^\.\//, "").replace(/\/?$/, "/");
  return base === "/" ? matching : matching.filter((option) => option.label.startsWith(base))
    .map((option) => ({ ...option, label: option.label.slice(base.length) }));
}

const STANDARD_BIBLIOGRAPHY_STYLES = ["abbrv", "abbrvnat", "acm", "alpha", "apalike", "ieeetr", "plain", "plainnat", "siam", "unsrt", "unsrtnat"];

function bibliographyStyles(files: readonly LatexCompletionItem[]): Completion[] {
  const project = files.filter((file) => /\.bst$/i.test(file.label)).map((file) => file.label.replace(/\.bst$/i, ""));
  return [...new Set([...project, ...STANDARD_BIBLIOGRAPHY_STYLES])].map((label) => ({ label, type: "text" }));
}

/** Commands that only mean something in math, offered first there and later in prose. */
const MATH_COMMANDS = new Set([
  ...fallbackCommandLabels.slice(fallbackCommandLabels.indexOf("\\displaystyle"), fallbackCommandLabels.indexOf("\\LaTeX")),
  "\\frac", "\\dfrac", "\\tfrac", "\\sqrt", "\\binom", "\\mathbf", "\\mathrm", "\\mathit", "\\mathsf", "\\mathtt", "\\mathbb", "\\mathcal", "\\mathscr",
  "\\boldsymbol", "\\hat", "\\widehat", "\\bar", "\\overline", "\\vec", "\\tilde", "\\widetilde", "\\dot", "\\ddot", "\\overset", "\\underset", "\\overbrace",
  "\\underbrace", "\\left", "\\right", "\\middle", "\\operatorname", "\\pmod", "\\bmod", "\\zeta", "\\eta", "\\iota", "\\kappa", "\\nu", "\\xi", "\\chi", "\\psi"
]);

function rankedForRegion(option: Completion, region: string): Completion {
  return MATH_COMMANDS.has(option.label) ? { ...option, boost: region === "math" ? 20 : -20 } : option;
}

export function latexCompletions(context: CompletionContext, t: TFunction, index: LatexCompletionIndex | null) {
  // Do not build the current-file symbol index during ordinary prose input.
  // CodeMirror reuses results while validFor matches the current token.
  const local = () => localCompletionIndexForDocument(context);
  const cursor = latexCompletionContext(context);
  if (!cursor.available || cursor.region === "comment" || cursor.region === "literal") return null;
  const argument = cursor.argument;
  if (argument?.kind === "environment") {
    const options = mergeCompletionItems(t, withoutSnippets(local().environments), withoutSnippets(index?.environments ?? []));
    return {
      from: argument.from,
      options: withoutCompletionDetails(options.map((option) => replacingTail(environmentCompletion(option, argument.command as "begin" | "end"), ENVIRONMENT_TAIL))),
      validFor: /^[A-Za-z0-9@:*_.+\-]*$/
    };
  }
  const replacing = (options: Completion[], tail: RegExp) => options.map((option) => replacingTail(option, tail));
  if (argument?.kind === "label") return { from: argument.from, options: replacing(mergeCompletionItems(t, local().labels, index?.labels ?? []), LIST_ITEM_TAIL), validFor: /^[^,{}%\s]*$/ };
  if (argument?.kind === "citation") return { from: argument.from, options: replacing(mergeCompletionItems(t, local().citations, bibtexCitationItems(index)), LIST_ITEM_TAIL), validFor: /^[^,{}%\s]*$/ };
  if (argument?.kind === "file") return {
    from: argument.from,
    options: replacing(filesForCommand(withoutCompletionDetails(mergeCompletionItems(t, local().files, index?.files ?? [])), argument.command, argument.firstArgument), argument.command === "bibliography" ? LIST_ITEM_TAIL : ARGUMENT_TAIL),
    validFor: argument.command === "bibliography" ? /^[^,{}%\s]*$/ : /^[^{}]*$/
  };
  if (argument?.kind === "package") return { from: argument.from, options: replacing(mergeCompletionItems(t, local().packages, index?.packages ?? []), LIST_ITEM_TAIL), validFor: /^[^,{}%\s]*$/ };
  if (argument?.kind === "class") return { from: argument.from, options: replacing(mergeCompletionItems(t, local().classes, index?.classes ?? []), ARGUMENT_TAIL), validFor: /^[^{}]*$/ };
  if (argument?.kind === "bibliographyStyle") return { from: argument.from, options: replacing(bibliographyStyles(index?.files ?? []), ARGUMENT_TAIL), validFor: /^[^{}]*$/ };
  const command = context.matchBefore(/\\(?:[A-Za-z@0-9:_]*(?:\*)?|[,;!:])$/);
  if (command) {
    const from = Math.max(0, command.from - 256);
    if (isLatexEscaped(context.state.sliceDoc(from, command.from + 1), command.from - from)) return null;
  }
  if (command || context.explicit) {
    const options = withoutCompletionDetails(mergeCompletionItems(t, local().commands, index?.commands ?? [], completionOptions()));
    const known = new Set(options.map((option) => option.label));
    return { from: command?.from ?? context.pos, options: options.map((option) => replacingCommand(rankedForRegion(option, cursor.region), known)), validFor: /^\\(?:[A-Za-z@0-9:_]*(?:\*)?|[,;!:])$/ };
  }
  return null;
}
