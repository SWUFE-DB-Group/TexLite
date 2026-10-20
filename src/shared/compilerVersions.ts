export const COMPILER_VERSION_TOOLS = [
  { id: "texlive", name: "TeX Live" },
  { id: "pdflatex", name: "pdfLaTeX" },
  { id: "xelatex", name: "XeLaTeX" },
  { id: "lualatex", name: "LuaLaTeX" },
  { id: "latexmk", name: "latexmk" },
  { id: "bibtex", name: "BibTeX" },
  { id: "biber", name: "Biber" },
  { id: "texcount", name: "TeXcount" },
  { id: "chktex", name: "ChkTeX" }
] as const;

export interface CompilerToolVersion {
  id: typeof COMPILER_VERSION_TOOLS[number]["id"];
  version: string | null;
}

export interface CompilerVersionsResponse {
  tools: CompilerToolVersion[];
}
