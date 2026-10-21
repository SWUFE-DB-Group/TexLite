import { DIFF_DELETE, DIFF_EQUAL, makeDiff } from "@sanity/diff-match-patch";
import { cleanupTextDiff } from "../shared/textDiff";
import type { LatexTextEdit } from "./latexFormatterProtocol";

/** Shared by the TeX and BibTeX workers; does not load either formatter. */
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
