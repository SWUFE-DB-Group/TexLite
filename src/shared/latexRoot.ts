import { maskLatexComments, maskLatexLiteralContent } from "./latexLiterals.js";

function isEscaped(source: string, index: number): boolean {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && source[cursor] === "\\"; cursor -= 1) backslashes += 1;
  return backslashes % 2 === 1;
}

/**
 * Return whether source contains a real `\\documentclass` declaration.
 * Literal code and comments are ignored consistently by browser-side root
 * selection and server-side ZIP import.
 */
export function hasLatexDocumentClass(source: string): boolean {
  const visible = maskLatexComments(maskLatexLiteralContent(source));
  const declaration = /\\documentclass(?![A-Za-z@])\s*(?:\[[^\]]*\]\s*)?\{/g;
  for (const match of visible.matchAll(declaration)) {
    if (match.index !== undefined && !isEscaped(visible, match.index)) return true;
  }
  return false;
}
