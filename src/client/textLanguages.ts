import type { Extension } from "@codemirror/state";

export type TextLanguageKind = "json" | "yaml" | "javascript" | "jsx" | "typescript" | "tsx"
  | "html" | "css" | "xml" | "markdown" | "toml" | "perl" | "docker" | "cmake" | "ini" | "shell" | "python";

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
  if (extension === "toml" || name === "cargo.lock") return "toml";
  if (extension === "pl" || extension === "pm" || /^\.?latexmkrc$/.test(name)) return "perl";
  if (name === "dockerfile" || name.startsWith("dockerfile.")) return "docker";
  if (extension === "cmake" || name === "cmakelists.txt") return "cmake";
  if (/^(?:ini|properties|cfg)$/.test(extension) || name === ".env" || name.startsWith(".env.")) return "ini";
  if (/^(?:sh|bash|zsh|ksh|bashrc|zshrc|profile)$/.test(extension)
    || /^(?:\.bashrc|\.zshrc|\.profile|\.bash_profile|pkgbuild)$/.test(name)
    || /^#!.*\b(?:bash|sh|zsh|ksh)\b/.test(firstLine)) return "shell";
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
