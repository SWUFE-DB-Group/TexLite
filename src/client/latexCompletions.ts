import type { TFunction } from "i18next";
import { Transaction } from "@codemirror/state";
import { pickedCompletion, snippetCompletion, type Completion, type CompletionContext } from "@codemirror/autocomplete";
import type { LatexCompletionIndex, LatexCompletionItem } from "./types";
import { latexArgumentCompletionContext, latexCitationCompletionContext, latexEnvironmentCompletionContext, latexEnvironmentCompletionPlan } from "./latexCompletionContexts";

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
  for (const match of source.matchAll(/\\(?:usepackage|RequirePackage)\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}/g)) {
    for (const packageName of match[1].split(",")) add(packages, packageName.trim(), "Package", "text");
  }
  for (const match of source.matchAll(/\\(?:input|include|subfile)\s*(?:\{([^}]+)\}|\s+([^\s%]+))/g)) add(files, (match[1] ?? match[2] ?? "").trim(), "Project file", "text");
  for (const match of source.matchAll(/\\(?:cite|citep|citet|parencite|textcite|autocite|footcite)(?:\w*)?(?:\s*\[[^\]]*\])*\s*\{([^}]+)\}/g)) {
    for (const key of match[1].split(",")) add(citations, key.trim(), "Citation key", "constant");
  }
  return { commands, environments, labels, citations, packages, classes: [], files };
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
  if (isLatexComment(context)) return null;
  // Do not build the current-file symbol index during ordinary prose input.
  // CodeMirror reuses results while validFor matches the current token.
  const local = () => localCompletionIndexForDocument(context);
  const environment = latexEnvironmentCompletionContext(context);
  if (environment) {
    const options = mergeCompletionItems(t, withoutSnippets(local().environments), withoutSnippets(index?.environments ?? []));
    return {
      from: environment.from,
      options: withoutCompletionDetails(options.map((option) => environmentCompletion(option, environment.command))),
      validFor: /^[A-Za-z0-9*:_-]*$/
    };
  }
  const label = latexArgumentCompletionContext(context, /\\(?:ref|pageref|autoref|nameref|cref|Cref|eqref|vref)\*?(?:\s*\[[^\]]*\])*\s*\{([^{}]*)$/, true)
    ?? latexArgumentCompletionContext(context, /\\hyperref\[([^\[\]]*)$/);
  if (label) return { from: label.from, options: mergeCompletionItems(t, local().labels, index?.labels ?? []), validFor: /^[^,{}\s]*$/ };
  const citation = latexCitationCompletionContext(context);
  if (citation) return { from: citation.from, options: mergeCompletionItems(t, local().citations, index?.citations ?? []), validFor: /^[^,{}\s]*$/ };
  const file = latexArgumentCompletionContext(context, /\\(?:input|include|subfile|includegraphics|bibliography|addbibresource)(?:\s*\[[^\]]*\])*\s*\{([^{}]*)$/);
  if (file) return { from: file.from, options: mergeCompletionItems(t, local().files, index?.files ?? []), validFor: /^[^{}]*$/ };
  const packageName = latexArgumentCompletionContext(context, /\\(?:usepackage|RequirePackage)(?:\s*\[[^\]]*\])*\s*\{([^{}]*)$/, true);
  if (packageName) return { from: packageName.from, options: mergeCompletionItems(t, local().packages, index?.packages ?? []), validFor: /^[^,{}\s]*$/ };
  const documentClass = latexArgumentCompletionContext(context, /\\documentclass(?:\s*\[[^\]]*\])*\s*\{([^{}]*)$/);
  if (documentClass) return { from: documentClass.from, options: mergeCompletionItems(t, index?.classes ?? []), validFor: /^[^{}]*$/ };
  const command = context.matchBefore(/\\(?:[A-Za-z@0-9:_]*(?:\*)?|[,;!:])$/);
  if (command || context.explicit) {
    return { from: command?.from ?? context.pos, options: withoutCompletionDetails(mergeCompletionItems(t, local().commands, index?.commands ?? [], completionOptions())), validFor: /^\\(?:[A-Za-z@0-9:_]*(?:\*)?|[,;!:])$/ };
  }
  return null;
}
