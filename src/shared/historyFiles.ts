/** File types for which a source-level snapshot diff is meaningful. */
export function isHistoryTextFile(filePath: string): boolean {
  const name = filePath.split("/").at(-1) ?? "";
  return /\.(?:tex|bib|bst|sty|cls|txt|md|rst|dat|csv|tsv|json|ya?ml|toml|xml|html?|css|[cm]?js|tsx?|py|sh|r|log|bbl|aux|idx|ind|gls)$/i.test(name)
    || /^(?:\.?latexmkrc|readme|licen[cs]e|makefile)$/i.test(name);
}
