/* Derived from TeXlyre/codemirror-lang-bib (MIT). See LICENSE. */

import {
  StringEntryType,
  PreambleEntryType,
  CommentEntryType
} from "./generatedParser.terms.mjs";

/**
 * Lezer's built-in `@specialize` table is literal/case-sensitive. BibTeX's
 * @string, @preamble, and @comment forms are conventionally
 * case-insensitive, so map their token text after normalizing it here.
 */
export function specializeEntryType(value) {
  switch (value.toLowerCase()) {
    case "@string": return StringEntryType;
    case "@preamble": return PreambleEntryType;
    case "@comment": return CommentEntryType;
    default: return -1;
  }
}
