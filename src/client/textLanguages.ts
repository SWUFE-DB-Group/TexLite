import type { Extension } from "@codemirror/state";

export type TextLanguageKind = "json" | "yaml" | "javascript" | "jsx" | "typescript" | "tsx"
  | "html" | "css" | "xml" | "markdown" | "latexmkrc" | "python";

export function isLatexEditorFile(filePath: string): boolean {
  return /\.(?:tex|sty|cls|ltx|dtx|ins|def)$/i.test(filePath);
}

/** File detection stays synchronous and must not import any auxiliary parsers. */
export function textLanguageKind(filePath: string, firstLine = ""): TextLanguageKind | null {
  const name = filePath.split("/").at(-1)?.toLowerCase() ?? "";
  const extension = name.split(".").at(-1) ?? "";
  if (extension === "json" || extension === "jsonl" || extension === "ipynb") return "json";
  if (extension === "yaml" || extension === "yml") return "yaml";
  if (/^(?:[cm]?js|jsx|[cm]?ts|tsx)$/.test(extension)) {
    if (extension === "jsx" || extension === "tsx") return extension;
    return /^(?:[cm]?ts)$/.test(extension) ? "typescript" : "javascript";
  }
  if (/^(?:html?|xhtml)$/.test(extension)) return "html";
  if (extension === "css") return "css";
  if (/^(?:xml|xsl|xslt|xsd)$/.test(extension)) return "xml";
  if (/^(?:md|markdown|mdown)$/.test(extension) || name === "readme") return "markdown";
  if (name === "latexmkrc" || name === ".latexmkrc") return "latexmkrc";
  if (extension === "py" || extension === "pyw" || /^#!.*\bpython[\d.]*\b/.test(firstLine)) return "python";
  return null;
}

let support: Promise<typeof import("./textLanguageSupport")> | null = null;

/** One shared lazy import per page; failed requests may be retried. */
export async function loadTextFileLanguage(filePath: string, firstLine = ""): Promise<Extension> {
  const kind = textLanguageKind(filePath, firstLine);
  if (!kind) return [];
  support ??= import("./textLanguageSupport").catch((error: unknown) => {
    support = null;
    throw error;
  });
  return (await support).textLanguageSupport(kind);
}
