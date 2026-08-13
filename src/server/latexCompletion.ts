import fs from "node:fs";
import type { Config } from "./config.js";
import { listProjectFiles, listProjectFilesAsync, resolveSourcePath } from "./files.js";

export type LatexCompletionKind = "keyword" | "function" | "class" | "constant" | "text";

export interface LatexCompletionItem {
  label: string;
  detail: string;
  kind: LatexCompletionKind;
  apply?: string;
  info?: string;
  source?: string;
}

export interface LatexCompletionIndex {
  commands: LatexCompletionItem[];
  environments: LatexCompletionItem[];
  labels: LatexCompletionItem[];
  citations: LatexCompletionItem[];
  packages: LatexCompletionItem[];
  files: LatexCompletionItem[];
}

interface MutableIndex {
  commands: Map<string, LatexCompletionItem>;
  environments: Map<string, LatexCompletionItem>;
  labels: Map<string, LatexCompletionItem>;
  citations: Map<string, LatexCompletionItem>;
  packages: Map<string, LatexCompletionItem>;
  files: Map<string, LatexCompletionItem>;
}

const textExtensions = /\.(?:tex|sty|cls|def|cfg|bib|bst|fd|dtx|ins)$/i;
const definitionExtensions = /\.(?:tex|sty|cls|def|cfg|dtx|ins)$/i;
const maxIndexedFileBytes = 3 * 1024 * 1024;
const maxIndexedBytes = 24 * 1024 * 1024;
const maxIndexedFiles = 500;

// This is deliberately kept as metadata rather than hard-coded in the editor,
// so the same vocabulary is available to every client and can be extended later.
const standardCommands: Array<[string, string, string?]> = [
  ["\\documentclass", "Document class", "\\documentclass[${options}]{${class}}"],
  ["\\usepackage", "Load package", "\\usepackage[${options}]{${package}}"],
  ["\\RequirePackage", "Load package", "\\RequirePackage{${package}}"],
  ["\\documentstyle", "Document style"], ["\\title", "Document title"], ["\\author", "Document author"], ["\\date", "Document date"],
  ["\\maketitle", "Render title"], ["\\tableofcontents", "Table of contents"], ["\\listoffigures", "List of figures"], ["\\listoftables", "List of tables"],
  ["\\part", "Part heading", "\\part{${title}}"], ["\\chapter", "Chapter heading", "\\chapter{${title}}"], ["\\section", "Section heading", "\\section{${title}}"],
  ["\\subsection", "Subsection heading", "\\subsection{${title}}"], ["\\subsubsection", "Subsubsection heading", "\\subsubsection{${title}}"],
  ["\\paragraph", "Paragraph heading", "\\paragraph{${title}}"], ["\\subparagraph", "Subparagraph heading", "\\subparagraph{${title}}"],
  ["\\label", "Create label", "\\label{${label}}"], ["\\ref", "Reference label", "\\ref{${label}}"], ["\\pageref", "Page reference", "\\pageref{${label}}"],
  ["\\autoref", "Automatic reference", "\\autoref{${label}}"], ["\\hyperref", "Hyperlink reference", "\\hyperref[${label}]{${text}}"],
  ["\\cite", "Citation", "\\cite{${key}}"], ["\\citep", "Parenthetical citation", "\\citep{${key}}"], ["\\citet", "Textual citation", "\\citet{${key}}"],
  ["\\parencite", "Parenthetical citation", "\\parencite{${key}}"], ["\\textcite", "Textual citation", "\\textcite{${key}}"],
  ["\\footnote", "Footnote", "\\footnote{${text}}"], ["\\marginpar", "Margin note", "\\marginpar{${text}}"],
  ["\\textbf", "Bold text", "\\textbf{${text}}"], ["\\textit", "Italic text", "\\textit{${text}}"], ["\\texttt", "Monospace text", "\\texttt{${text}}"],
  ["\\textrm", "Roman text", "\\textrm{${text}}"], ["\\textsf", "Sans-serif text", "\\textsf{${text}}"], ["\\textsc", "Small caps text", "\\textsc{${text}}"],
  ["\\emph", "Emphasized text", "\\emph{${text}}"], ["\\underline", "Underlined text", "\\underline{${text}}"], ["\\mbox", "Unbreakable text", "\\mbox{${text}}"],
  ["\\textwidth", "Text width"], ["\\linewidth", "Current line width"], ["\\columnwidth", "Column width"], ["\\paperwidth", "Paper width"],
  ["\\include", "Include LaTeX file", "\\include{${file}}"], ["\\input", "Input LaTeX file", "\\input{${file}}"], ["\\includeonly", "Limit included files", "\\includeonly{${file}}"],
  ["\\includegraphics", "Include image", "\\includegraphics[width=${0.8}\\textwidth]{${file}}"], ["\\graphicspath", "Image search path", "\\graphicspath{{${path}/}}"],
  ["\\caption", "Caption", "\\caption{${caption}}"], ["\\captionof", "Caption outside float", "\\captionof{${type}}{${caption}}"],
  ["\\centering", "Center contents"], ["\\raggedright", "Left align contents"], ["\\raggedleft", "Right align contents"], ["\\newline", "Line break"],
  ["\\linebreak", "Suggest line break"], ["\\pagebreak", "Suggest page break"], ["\\clearpage", "Flush floats and page break"], ["\\newpage", "Page break"], ["\\vspace", "Vertical space", "\\vspace{${length}}"],
  ["\\hspace", "Horizontal space", "\\hspace{${length}}"], ["\\hfill", "Horizontal fill"], ["\\vfill", "Vertical fill"], ["\\rule", "Rule", "\\rule{${width}}{${height}}"],
  ["\\ldots", "Ellipsis"], ["\\dots", "Ellipsis"], ["\\LaTeX", "LaTeX logo"], ["\\TeX", "TeX logo"], ["\\today", "Current date"],
  ["\\newcommand", "Define command", "\\newcommand{\\${name}}[${args}] {${definition}}"], ["\\renewcommand", "Redefine command"], ["\\providecommand", "Provide command"],
  ["\\newenvironment", "Define environment", "\\newenvironment{${name}}{${begin}}{${end}}"], ["\\renewenvironment", "Redefine environment"],
  ["\\newlength", "Define length", "\\newlength{\\${name}}"], ["\\setlength", "Set length", "\\setlength{\\${length}}{${value}}"], ["\\addtolength", "Adjust length"],
  ["\\newcounter", "Define counter", "\\newcounter{${name}}"], ["\\setcounter", "Set counter"], ["\\stepcounter", "Step counter"], ["\\value", "Counter value"],
  ["\\newtheorem", "Define theorem", "\\newtheorem{${name}}{${caption}}"], ["\\DeclareMathOperator", "Define math operator"], ["\\operatorname", "Math operator"],
  ["\\frac", "Fraction", "\\frac{${numerator}}{${denominator}}"], ["\\dfrac", "Display fraction", "\\dfrac{${numerator}}{${denominator}}"], ["\\tfrac", "Text fraction", "\\tfrac{${numerator}}{${denominator}}"],
  ["\\sqrt", "Square root", "\\sqrt[${index}]{${radicand}}"], ["\\sum", "Summation"], ["\\prod", "Product"], ["\\int", "Integral"], ["\\lim", "Limit"],
  ["\\mathbf", "Bold math", "\\mathbf{${symbol}}"], ["\\mathrm", "Roman math", "\\mathrm{${symbol}}"], ["\\mathit", "Italic math", "\\mathit{${symbol}}"],
  ["\\left", "Scalable left delimiter"], ["\\right", "Scalable right delimiter"], ["\\text", "Text in math", "\\text{${text}}"],
  ["\\begin", "Begin environment", "\\begin{${environment}}"], ["\\end", "End environment", "\\end{${environment}}"],
  ["\\item", "List item", "\\item ${text}"],
  ["\\bibliography", "Bibliography database", "\\bibliography{${file}}"], ["\\bibliographystyle", "Bibliography style", "\\bibliographystyle{${style}}"],
  ["\\printbibliography", "Print bibliography"], ["\\addbibresource", "Add bibliography resource", "\\addbibresource{${file}}"],
  ["\\definecolor", "Define color", "\\definecolor{${name}}{${model}}{${specification}}"], ["\\color", "Set text color", "\\color{${color}}"], ["\\textcolor", "Colored text", "\\textcolor{${color}}{${text}}"],
  ["\\url", "URL", "\\url{${url}}"], ["\\href", "Hyperlink", "\\href{${url}}{${text}}"], ["\\verb", "Verbatim text"], ["\\verb*", "Verbatim text"],
  ["\\begin{itemize}", "Unordered list", "\\begin{itemize}\n\t\\item ${item}\n\\end{itemize}"],
  ["\\begin{enumerate}", "Numbered list", "\\begin{enumerate}\n\t\\item ${item}\n\\end{enumerate}"],
  ["\\begin{figure}", "Figure environment", "\\begin{figure}[htbp]\n\t\\centering\n\t${content}\n\t\\caption{${caption}}\n\t\\label{fig:${label}}\n\\end{figure}"],
  ["\\begin{table}", "Table environment", "\\begin{table}[htbp]\n\t\\centering\n\t${content}\n\t\\caption{${caption}}\n\t\\label{tab:${label}}\n\\end{table}"],
  ["\\begin{equation}", "Equation environment", "\\begin{equation}\n\t${equation}\n\\end{equation}"],
  ["\\begin{align}", "Aligned equation", "\\begin{align}\n\t${equation}\n\\end{align}"],
  ["\\begin{tikzpicture}", "TikZ picture", "\\begin{tikzpicture}\n\t${content}\n\\end{tikzpicture}"],
  ["\\begin{document}", "Document body", "\\begin{document}\n${content}\n\\end{document}"]
];

const standardEnvironments: Array<[string, string, string?]> = [
  ["document", "Document body", "\\begin{document}\n${content}\n\\end{document}"],
  ["itemize", "Unordered list", "\\begin{itemize}\n\t\\item ${item}\n\\end{itemize}"],
  ["enumerate", "Numbered list", "\\begin{enumerate}\n\t\\item ${item}\n\\end{enumerate}"],
  ["description", "Description list"], ["figure", "Figure float"], ["table", "Table float"], ["tabular", "Table contents"],
  ["equation", "Displayed equation"], ["equation*", "Unnumbered equation"], ["align", "Aligned equations"], ["align*", "Unnumbered aligned equations"],
  ["gather", "Gathered equations"], ["multline", "Multiline equation"], ["split", "Split equation"], ["cases", "Cases"],
  ["verbatim", "Verbatim block"], ["verbatim*", "Verbatim block"], ["quote", "Short quotation"], ["quotation", "Long quotation"], ["verse", "Verse"],
  ["center", "Centered block"], ["flushleft", "Left-aligned block"], ["flushright", "Right-aligned block"], ["minipage", "Mini page"],
  ["abstract", "Abstract"], ["appendix", "Appendix"], ["theorem", "Theorem"], ["lemma", "Lemma"], ["proof", "Proof"],
  ["tikzpicture", "TikZ picture"], ["frame", "Beamer frame"]
];

const standardPackages = [
  "amsmath", "amssymb", "amsthm", "array", "babel", "biblatex", "booktabs", "caption", "cleveref", "enumitem", "float",
  "geometry", "graphicx", "hyperref", "listings", "longtable", "mathtools", "microtype", "multirow", "natbib", "pgfplots",
  "tcolorbox", "tikz", "url", "xcolor", "xurl"
];

const standardClasses = ["article", "report", "book", "letter", "memoir", "beamer", "standalone", "scrartcl", "scrreprt", "scrbook", "IEEEtran", "acmart"];

function item(label: string, detail: string, kind: LatexCompletionKind, source?: string, apply?: string): LatexCompletionItem {
  return { label, detail, kind, source, ...(apply ? { apply } : {}) };
}

function createIndex(): MutableIndex {
  return {
    commands: new Map(), environments: new Map(), labels: new Map(), citations: new Map(), packages: new Map(), files: new Map()
  };
}

function withoutComments(content: string): string {
  return content.split("\n").map((line) => line.replace(/(^|[^\\])%.*$/, "$1")).join("\n");
}

function commandItem(index: MutableIndex, name: string, detail: string, source: string, apply?: string): void {
  if (!name.startsWith("\\")) name = `\\${name}`;
  if (!/^\\[A-Za-z@][A-Za-z@0-9:_]*$/.test(name)) return;
  const existing = index.commands.get(name);
  // A project definition is more useful than the generic built-in entry: it
  // carries the actual argument count and therefore the right snippet.
  if (!existing || (existing.source === "LaTeX" && source !== "LaTeX")) index.commands.set(name, item(name, detail, "function", source, apply));
}

function commandSnippet(name: string, argumentCount: number): string | undefined {
  if (argumentCount <= 0) return undefined;
  const placeholder = (index: number) => `\${${index}}`;
  return name + Array.from({ length: argumentCount }, (_, index) => `{${placeholder(index + 1)}}`).join("");
}

function xparseArgumentCount(specification: string): number {
  // The common xparse argument types all consume one user supplied value.
  // Modifiers such as `+` and argument delimiters are intentionally ignored.
  return [...specification.matchAll(/[moOrRdDsStvb]/g)].length;
}

function extractSymbols(index: MutableIndex, filePath: string, original: string): void {
  const content = withoutComments(original);
  const source = filePath;
  for (const match of content.matchAll(/\\(?:newcommand|renewcommand|providecommand|DeclareRobustCommand)\s*\*?\s*(?:\{\s*)?\\([A-Za-z@][A-Za-z@0-9:_]*)\s*(?:\})?\s*(?:\[(\d+)\])?/g)) {
    const args = Number.parseInt(match[2] ?? "0", 10);
    commandItem(index, `\\${match[1]}`, `Project command (${args} argument${args === 1 ? "" : "s"})`, source, commandSnippet(`\\${match[1]}`, args));
  }
  for (const match of content.matchAll(/\\(?:NewDocumentCommand|RenewDocumentCommand|ProvideDocumentCommand|DeclareDocumentCommand|DeclareExpandableDocumentCommand|RenewExpandableDocumentCommand|ProvideExpandableDocumentCommand)\s*\{\s*\\([A-Za-z@][A-Za-z@0-9:_]*)\s*\}\s*\{([^}]*)\}/g)) {
    const args = xparseArgumentCount(match[2]);
    commandItem(index, `\\${match[1]}`, `Project command (${args} argument${args === 1 ? "" : "s"})`, source, commandSnippet(`\\${match[1]}`, args));
  }
  for (const match of content.matchAll(/\\(?:def|gdef|edef|xdef)\s*\\([A-Za-z@][A-Za-z@0-9:_]*)((?:\s*#\d+)*)/g)) {
    const args = [...(match[2] ?? "").matchAll(/#\d+/g)].length;
    commandItem(index, `\\${match[1]}`, "Project macro", source, commandSnippet(`\\${match[1]}`, args));
  }
  for (const match of content.matchAll(/\\DeclareMathOperator\s*\*?\s*\{?\\([A-Za-z@][A-Za-z@0-9:_]*)\}?/g)) commandItem(index, `\\${match[1]}`, "Project math operator", source);
  for (const match of content.matchAll(/\\DeclarePairedDelimiter\s*\{?\\([A-Za-z@][A-Za-z@0-9:_]*)\}?/g)) commandItem(index, `\\${match[1]}`, "Project math delimiter", source);
  for (const match of content.matchAll(/\\cs_(?:new|set|gset|provide|generate)(?:_protected)?\:[A-Za-z]+\s+\\([A-Za-z@][A-Za-z@0-9:_]*)/g)) commandItem(index, `\\${match[1]}`, "Expl3 project command", source);
  for (const match of content.matchAll(/\\(?:newenvironment|renewenvironment|NewDocumentEnvironment|RenewDocumentEnvironment|DeclareDocumentEnvironment)\s*\*?\s*\{([^}]+)\}/g)) {
    const name = match[1].trim();
    const existing = index.environments.get(name);
    if (/^[A-Za-z][A-Za-z0-9*_-]*$/.test(name) && (!existing || (existing.source === "LaTeX" && source !== "LaTeX"))) {
      index.environments.set(name, item(name, "Project environment", "keyword", source));
    }
  }
  for (const match of content.matchAll(/\\(?:newtheorem|declaretheorem)\s*\*?\s*\{([^}]+)\}/g)) {
    const name = match[1].trim();
    const existing = index.environments.get(name);
    if (/^[A-Za-z][A-Za-z0-9*_-]*$/.test(name) && (!existing || (existing.source === "LaTeX" && source !== "LaTeX"))) {
      index.environments.set(name, item(name, "Theorem environment", "keyword", source));
    }
  }
  for (const match of content.matchAll(/\\(?:label|hypertarget)\s*\{([^}]+)\}/g)) {
    const label = match[1].trim();
    if (label && !index.labels.has(label)) index.labels.set(label, item(label, "Label", "constant", source));
  }
  for (const match of content.matchAll(/\\(?:input|include|subfile|import)\s*(?:\{([^}]+)\}|\s+([^\s%]+))/g)) {
    const file = (match[1] ?? match[2] ?? "").trim();
    if (file) index.files.set(file, item(file, "Project file", "text", source));
  }
  for (const match of content.matchAll(/\\(?:usepackage|RequirePackage|documentclass)\s*(?:\[[^]]*\])?\s*\{([^}]+)\}/g)) {
    for (const packageName of match[1].split(",").map((value) => value.trim()).filter(Boolean)) {
      const target = /documentclass|documentstyle/.test(match[0]) ? index.files : index.packages;
      if (!target.has(packageName)) target.set(packageName, item(packageName, target === index.files ? "Document class" : "Package", "text", source));
    }
  }
  for (const match of content.matchAll(/\\(?:cite|citep|citet|parencite|textcite|autocite|footcite)(?:\w*)?\s*(?:\[[^]]*\])?\s*\{([^}]+)\}/g)) {
    for (const key of match[1].split(",").map((value) => value.trim()).filter(Boolean)) {
      if (!index.citations.has(key)) index.citations.set(key, item(key, "Citation key", "constant", source));
    }
  }
  for (const match of content.matchAll(/\\bibitem\s*(?:\[[^]]*\])?\s*\{([^}]+)\}/g)) {
    const key = match[1].trim();
    if (key && !index.citations.has(key)) index.citations.set(key, item(key, "Bibliography key", "constant", source));
  }
  for (const match of content.matchAll(/@(?:\w+)\s*\{\s*([^,\s]+)\s*,/g)) {
    const key = match[1].trim();
    if (key && !index.citations.has(key)) index.citations.set(key, item(key, "BibTeX key", "constant", source));
  }
}

function sorted(map: Map<string, LatexCompletionItem>): LatexCompletionItem[] {
  return [...map.values()].sort((left, right) => left.label.localeCompare(right.label));
}

function standardIndex(): MutableIndex {
  const index = createIndex();
  for (const [label, detail, apply] of standardCommands) commandItem(index, label, detail, "LaTeX", apply);
  for (const [label, detail, apply] of standardEnvironments) index.environments.set(label, item(label, detail, "keyword", "LaTeX", apply));
  for (const packageName of standardPackages) index.packages.set(packageName.trim(), item(packageName.trim(), "Package", "text", "LaTeX"));
  for (const className of standardClasses) index.files.set(className, item(className, "Document class", "class", "LaTeX"));
  return index;
}

export function buildLatexCompletionIndex(config: Config, projectId: string): LatexCompletionIndex {
  const index = standardIndex();
  const allEntries = listProjectFiles(config, projectId).filter((entry) => entry.type === "file").slice(0, maxIndexedFiles);
  for (const entry of allEntries) index.files.set(entry.path, item(entry.path, "Project file", "text", "Project"));
  const entries = allEntries.filter((entry) => textExtensions.test(entry.path));
  let indexedBytes = 0;
  for (const entry of entries) {
    const absolute = resolveSourcePath(config, projectId, entry.path);
    let content: string;
    try {
      const size = fs.statSync(absolute).size;
      if (size > maxIndexedFileBytes || indexedBytes + size > maxIndexedBytes) continue;
      indexedBytes += size;
      content = fs.readFileSync(absolute, "utf8");
    } catch {
      continue;
    }
    if (definitionExtensions.test(entry.path) || /\.bib$/i.test(entry.path)) extractSymbols(index, entry.path, content);
  }
  return {
    commands: sorted(index.commands), environments: sorted(index.environments), labels: sorted(index.labels),
    citations: sorted(index.citations), packages: sorted(index.packages), files: sorted(index.files)
  };
}

interface CachedSymbols {
  signature: string;
  index: MutableIndex;
}

/** Reuses extracted symbols for files whose mtime and size did not change. */
export class LatexCompletionService {
  private readonly cache = new Map<string, Map<string, CachedSymbols>>();
  private readonly pending = new Map<string, Promise<LatexCompletionIndex>>();

  constructor(private readonly config: Config) {}

  build(projectId: string): Promise<LatexCompletionIndex> {
    const existing = this.pending.get(projectId);
    if (existing) return existing;
    const request = this.buildIncremental(projectId).finally(() => {
      if (this.pending.get(projectId) === request) this.pending.delete(projectId);
    });
    this.pending.set(projectId, request);
    return request;
  }

  invalidate(projectId: string): void {
    this.cache.delete(projectId);
  }

  private async buildIncremental(projectId: string): Promise<LatexCompletionIndex> {
    const index = standardIndex();
    const projectCache = this.cache.get(projectId) ?? new Map<string, CachedSymbols>();
    this.cache.set(projectId, projectCache);
    const allEntries = (await listProjectFilesAsync(this.config, projectId)).filter((entry) => entry.type === "file").slice(0, maxIndexedFiles);
    const livePaths = new Set(allEntries.map((entry) => entry.path));
    for (const cachedPath of [...projectCache.keys()]) if (!livePaths.has(cachedPath)) projectCache.delete(cachedPath);
    for (const entry of allEntries) index.files.set(entry.path, item(entry.path, "Project file", "text", "Project"));

    let indexedBytes = 0;
    for (const entry of allEntries.filter((candidate) => textExtensions.test(candidate.path))) {
      const size = entry.size ?? 0;
      if (size > maxIndexedFileBytes || indexedBytes + size > maxIndexedBytes) continue;
      indexedBytes += size;
      const signature = `${size}:${entry.mtimeMs ?? 0}`;
      let cached = projectCache.get(entry.path);
      if (!cached || cached.signature !== signature) {
        let content: string;
        try { content = await fs.promises.readFile(resolveSourcePath(this.config, projectId, entry.path), "utf8"); }
        catch { projectCache.delete(entry.path); continue; }
        const fileIndex = createIndex();
        if (definitionExtensions.test(entry.path) || /\.bib$/i.test(entry.path)) extractSymbols(fileIndex, entry.path, content);
        cached = { signature, index: fileIndex };
        projectCache.set(entry.path, cached);
      }
      mergeIndex(index, cached.index);
    }
    return {
      commands: sorted(index.commands), environments: sorted(index.environments), labels: sorted(index.labels),
      citations: sorted(index.citations), packages: sorted(index.packages), files: sorted(index.files)
    };
  }
}

function mergeIndex(target: MutableIndex, source: MutableIndex): void {
  for (const value of source.commands.values()) commandItem(target, value.label, value.detail, value.source ?? "Project", value.apply);
  for (const key of ["environments", "labels", "citations", "packages", "files"] as const) {
    for (const [label, value] of source[key]) {
      const existing = target[key].get(label);
      if (!existing || (existing.source === "LaTeX" && value.source !== "LaTeX")) target[key].set(label, value);
    }
  }
}
