export type CompileDiagnosticSeverity = "warning" | "error";
export type CompileDiagnosticPhase = "pdflatex" | "xelatex" | "lualatex" | "bibtex" | "biber" | "latexmk" | "system" | "unknown";

export interface CompileDiagnostic {
  severity: CompileDiagnosticSeverity;
  phase: CompileDiagnosticPhase;
  message: string;
  raw: string;
  file?: string;
  line?: number;
  column?: number;
}

export interface CompileDiagnostics {
  warnings: CompileDiagnostic[];
  errors: CompileDiagnostic[];
}

export function formatCompileDiagnostic(diagnostic: CompileDiagnostic): string {
  const location = diagnostic.file
    ? `${diagnostic.file}${diagnostic.line ? `:${diagnostic.line}${diagnostic.column ? `:${diagnostic.column}` : ""}` : ""}`
    : diagnostic.line ? `line ${diagnostic.line}` : "";
  const prefix = `[${diagnostic.phase}]`;
  return [prefix, location, diagnostic.message].filter(Boolean).join(" ");
}
