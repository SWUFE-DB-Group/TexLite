/** Bibliographies are structured reference data, not prose. */
export function supportsWritingChecks(path: string): boolean {
  return !/\.bib$/i.test(path.trim());
}
