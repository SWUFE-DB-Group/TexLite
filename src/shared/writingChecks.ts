/** Writing checks are for prose, not arbitrary editable code/configuration. */
export function supportsWritingChecks(path: string): boolean {
  return /\.(?:tex|sty|cls|ltx|dtx|ins|txt|md|markdown|rst)$/i.test(path.trim());
}

/** ChkTeX checks LaTeX source files, not arbitrary project assets. */
export function supportsChktexChecks(path: string): boolean {
  return /\.(?:tex|sty|cls)$/i.test(path.trim());
}
