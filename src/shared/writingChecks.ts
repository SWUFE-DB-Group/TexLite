/** Bibliographies and BibTeX style programs are structured data/code, not prose. */
export function supportsWritingChecks(path: string): boolean {
  return !/\.(?:bib|bst)$/i.test(path.trim());
}

/** ChkTeX checks LaTeX source files, not arbitrary project assets. */
export function supportsChktexChecks(path: string): boolean {
  return /\.(?:tex|sty|cls)$/i.test(path.trim());
}
