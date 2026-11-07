import { tidy } from "bibtex-tidy";
import { isBibtexTooLarge } from "./bibtexLimits";

/**
 * Browser-side BibTeX formatting. bibtex-tidy is only a formatter here: what
 * counts as an entry, and whether a document is valid, is decided by the
 * editor's grammar (see `bibtex/entries.ts`). Keeping this module separate
 * means only the formatter worker bundles bibtex-tidy.
 */

export class BibtexFormatError extends Error {
  constructor(readonly kind: "too-large" | "invalid") {
    super(kind === "too-large" ? "BibTeX input is too large to format" : "BibTeX input is invalid");
    this.name = "BibtexFormatError";
  }
}

const tidyOptions = { lowercase: false, removeDuplicateFields: false } as const;

/** Format a BibTeX document without changing its field names or values. */
export function formatBibtex(source: string, maxBytes: number): string {
  if (!source.trim()) return source;
  if (isBibtexTooLarge(source, maxBytes)) throw new BibtexFormatError("too-large");
  try {
    return tidy(source, tidyOptions).bibtex;
  } catch {
    throw new BibtexFormatError("invalid");
  }
}
