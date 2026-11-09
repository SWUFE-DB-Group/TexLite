import { maskLatexComments, maskLatexLiteralContent } from "./latexLiterals.js";

/**
 * A complete `standalone` document that draws with TikZ, as opposed to a main
 * document. Comments and verbatim examples do not count.
 */
export function isStandaloneTikz(source: string): boolean {
  if (!source.includes("standalone")) return false;
  const visible = maskLatexComments(maskLatexLiteralContent(source));
  const declaration = /\\documentclass(?![A-Za-z@])\s*(?:\[([^\]]*)\]\s*)?\{\s*standalone\s*\}/.exec(visible);
  if (!declaration) return false;
  return (declaration[1] ?? "").split(",").some((option) => option.trim() === "tikz")
    || /\\begin\s*\{tikzpicture\}/.test(visible);
}
