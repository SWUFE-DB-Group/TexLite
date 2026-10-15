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
