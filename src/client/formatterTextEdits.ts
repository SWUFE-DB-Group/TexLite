import { textReplacements } from "../shared/textDiff";
import type { LatexTextEdit } from "./latexFormatterProtocol";

/** Shared by the TeX and BibTeX workers; does not load either formatter. */
export function calculateLatexTextEdits(source: string, formatted: string, baseOffset = 0): LatexTextEdit[] {
  return textReplacements(source, formatted, "efficiency").map(({ from, to, insert }) => ({
    from: baseOffset + from, to: baseOffset + to, replacement: insert
  }));
}
