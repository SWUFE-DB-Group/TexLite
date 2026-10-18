import type { TFunction } from "i18next";
import { Transaction } from "@codemirror/state";
import { pickedCompletion, snippetCompletion, type Completion, type CompletionContext } from "@codemirror/autocomplete";
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

function environmentCompletion(entry: Completion, command: "begin" | "end"): Completion {
  return {
    ...entry,
    apply(view, completion, from, to) {
      const name = completion.label;
      const plan = latexEnvironmentCompletionPlan(view.state.doc, from, to, name, command);
      view.dispatch({
        changes: { from, to: plan.to, insert: plan.insert },
        selection: { anchor: plan.cursor },
        annotations: [pickedCompletion.of(completion), Transaction.userEvent.of("input.complete")]
      });
    }
  };
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
      options: withoutCompletionDetails(options.map((option) => environmentCompletion(option, argument.command as "begin" | "end"))),
      validFor: /^[A-Za-z0-9@:*_.+\-]*$/
    };
  }
  if (argument?.kind === "label") return { from: argument.from, options: mergeCompletionItems(t, local().labels, index?.labels ?? []), validFor: /^[^,{}%\s]*$/ };
  if (argument?.kind === "citation") return { from: argument.from, options: mergeCompletionItems(t, local().citations, bibtexCitationItems(index)), validFor: /^[^,{}%\s]*$/ };
  if (argument?.kind === "file") return {
    from: argument.from,
    options: withoutCompletionDetails(mergeCompletionItems(t, local().files, index?.files ?? [])),
    validFor: argument.command === "bibliography" ? /^[^,{}%\s]*$/ : /^[^{}]*$/
  };
  if (argument?.kind === "package") return { from: argument.from, options: mergeCompletionItems(t, local().packages, index?.packages ?? []), validFor: /^[^,{}%\s]*$/ };
  if (argument?.kind === "class") return { from: argument.from, options: mergeCompletionItems(t, local().classes, index?.classes ?? []), validFor: /^[^{}]*$/ };
  const command = context.matchBefore(/\\(?:[A-Za-z@0-9:_]*(?:\*)?|[,;!:])$/);
  if (command) {
    const from = Math.max(0, command.from - 256);
    if (isLatexEscaped(context.state.sliceDoc(from, command.from + 1), command.from - from)) return null;
  }
  if (command || context.explicit) {
    return { from: command?.from ?? context.pos, options: withoutCompletionDetails(mergeCompletionItems(t, local().commands, index?.commands ?? [], completionOptions())), validFor: /^\\(?:[A-Za-z@0-9:_]*(?:\*)?|[,;!:])$/ };
  }
  return null;
}
