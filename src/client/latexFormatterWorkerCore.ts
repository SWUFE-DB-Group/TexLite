import { DIFF_DELETE, DIFF_EQUAL, makeDiff } from "@sanity/diff-match-patch";
import { main } from "tex-fmt";
import { cleanupTextDiff } from "../shared/textDiff";
import type { LatexTextEdit, TexFmtFailureKind, TexFmtResult } from "./latexFormatterProtocol";

export class LatexFormatterWorkerError extends Error {
  constructor(public readonly kind: TexFmtFailureKind, message: string) {
    super(message);
    this.name = "LatexFormatterWorkerError";
  }
}

export function formatTexSource(source: string, config: string): TexFmtResult {
  let result: unknown;
  try {
    result = main(source, config);
  } catch {
    throw new LatexFormatterWorkerError("format", "tex-fmt could not format this source. Check the TOML formatter options.");
  }
  if (!result || typeof result !== "object" || !("output" in result) || typeof result.output !== "string") {
    throw new LatexFormatterWorkerError("result", "tex-fmt returned an invalid formatting result.");
  }
  const logs = "logs" in result && typeof result.logs === "string" ? result.logs : "";
  return { output: result.output, logs };
}

export function calculateLatexTextEdits(source: string, formatted: string, baseOffset = 0): LatexTextEdit[] {
  if (source === formatted) return [];
  const diffs = cleanupTextDiff(makeDiff(source, formatted, { checkLines: true, timeout: 1 }), "efficiency");
  const edits: LatexTextEdit[] = [];
  let sourceOffset = baseOffset;
  let pending: LatexTextEdit | null = null;
  const flush = () => {
    if (pending) edits.push(pending);
    pending = null;
  };
  for (const [kind, text] of diffs) {
    if (kind === DIFF_EQUAL) {
      flush();
      sourceOffset += text.length;
    } else if (kind === DIFF_DELETE) {
      pending ??= { from: sourceOffset, to: sourceOffset, replacement: "" };
      pending.to += text.length;
      sourceOffset += text.length;
    } else {
      pending ??= { from: sourceOffset, to: sourceOffset, replacement: "" };
      pending.replacement += text;
    }
  }
  flush();
  return edits;
}
