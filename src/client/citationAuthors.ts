import type { TFunction } from "i18next";
import { splitBibtexNames, truncateBibtexNames } from "../shared/bibtexNames";
import { bibtexDisplayText } from "../shared/bibtexText";

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
 * name written as `Last, First` already contains a comma. The list is split
 * on the TeX source, where braces still protect corporate names, and each
 * name is then converted to readable text.
 */
export function formatCitationAuthors(authors: string, labels: CitationAuthorLabels): string {
  const list = splitBibtexNames(authors);
  if (!list.names.length) return bibtexDisplayText(authors);
  const { shown, truncated, total } = truncateBibtexNames(list);
  const names = shown.map(bibtexDisplayText).join(NAME_SEPARATOR);
  if (!truncated) return names;
  return total === null ? labels.authorsOthers(names) : labels.authorsTruncated(names, total);
}
