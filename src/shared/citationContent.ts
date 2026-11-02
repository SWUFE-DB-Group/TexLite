export interface CitationContentMatch {
  id: string;
  citationKey: string;
  revision: number;
  sameContent: boolean;
}

/** Ignore platform line endings and whitespace outside the entry, not its fields. */
export function comparableCitationBibtex(bibtex: string): string {
  return bibtex.replace(/\r\n?/g, "\n").trim();
}
