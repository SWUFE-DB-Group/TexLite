import type { LatexTextEdit } from "./latexFormatterProtocol";

export type BibtexFormatterFailureKind = "too-large" | "invalid" | "unavailable" | "timeout";

export type BibtexFormatterWorkerRequest =
  | { id: number; action: "format"; source: string; maxBytes: number }
  | { id: number; action: "diff"; source: string; formatted: string; baseOffset: number };

export type BibtexFormatterWorkerResponse =
  | { id: number; ok: true; action: "format"; result: string }
  | { id: number; ok: true; action: "diff"; result: LatexTextEdit[] }
  | { id: number; ok: false; kind: BibtexFormatterFailureKind };
