import type { TFunction } from "i18next";
import { splitBibtexNames, truncateBibtexNames } from "../shared/bibtexNames";

export interface CitationAuthorLabels {
  /** Shown names followed by "et al." and the total number of authors. */
  authorsTruncated: (names: string, count: number) => string;
  /** Shown names followed by "et al." when `and others` leaves the total unknown. */
  authorsOthers: (names: string) => string;
}

export function citationAuthorLabels(t: TFunction): CitationAuthorLabels {
  return {
    authorsTruncated: (names, count) => t("citationLibrary.authorsTruncated", { names, count }),
    authorsOthers: (names) => t("citationLibrary.authorsOthers", { names })
  };
}

const NAME_SEPARATOR = "; ";

/**
 * Format a BibTeX author list for display with biblatex's default truncation
 * (`maxnames=3`, `minnames=1`). Names are joined with semicolons because a
 * name written as `Last, First` already contains a comma.
 */
export function formatCitationAuthors(authors: string, labels: CitationAuthorLabels): string {
  const list = splitBibtexNames(authors);
  if (!list.names.length) return authors;
  const { shown, truncated, total } = truncateBibtexNames(list);
  const names = shown.join(NAME_SEPARATOR);
  if (!truncated) return names;
  return total === null ? labels.authorsOthers(names) : labels.authorsTruncated(names, total);
}
