export type TexFmtFailureKind = "load" | "format" | "result";

export interface TexFmtResult {
  output: string;
  logs: string;
}

export interface LatexTextEdit {
  from: number;
  to: number;
  replacement: string;
}

export type LatexFormatterWorkerRequest =
  | { id: number; action: "probe" }
  | { id: number; action: "format"; source: string; config: string }
  | { id: number; action: "diff"; source: string; formatted: string; baseOffset: number };

export type LatexFormatterWorkerResponse =
  | { type: "ready" }
  | { id: number; ok: true; action: "probe"; result: true }
  | { id: number; ok: true; action: "format"; result: TexFmtResult }
  | { id: number; ok: true; action: "diff"; result: LatexTextEdit[] }
  | { id: number; ok: false; kind: TexFmtFailureKind; message: string };
