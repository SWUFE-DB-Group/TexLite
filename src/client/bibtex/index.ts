/*
 * Internal BibTeX language support for TexLite.
 *
 * Derived from TeXlyre/codemirror-lang-bib under the MIT license. See the
 * adjacent LICENSE file. This narrow entry point deliberately leaves generic
 * CodeMirror keymaps, indentation, close-brackets, and autocomplete UI under
 * TexLite's single editor configuration.
 */

import { linter } from "@codemirror/lint";
import { bracketMatching } from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import { parser } from "./parser";
import { bibtexLinter } from "./diagnostics";
import { createBibtexHoverTooltip } from "./hover";
import { defaultBibtexMessages, type BibtexMessages } from "./messages";

export const bibtexLanguage = parser;

export const bibtexBracketMatching = bracketMatching({
  brackets: "()[]{}"
});

/**
 * BibTeX-specific extensions only. Shared CodeMirror concerns such as
 * autocomplete UI, close brackets, indentation and keymaps stay in
 * LatexEditor so every source language has one consistent editor shell.
 */
export function createBibtexEditorExtensions(messages: BibtexMessages = defaultBibtexMessages): Extension[] {
  return [
    bibtexBracketMatching,
    linter(bibtexLinter({ messages })),
    createBibtexHoverTooltip(messages)
  ];
}

/** Default English extensions for isolated consumers and tests. */
export const bibtexEditorExtensions = createBibtexEditorExtensions();

export { bibtexCompletionSource, entryTypes, fieldNames, snippets } from "./completion";
export { bibtexLinter, type BibtexLinterOptions } from "./diagnostics";
export {
  bibtexHoverTooltip,
  bibtexHoverInfoAt,
  createBibtexHoverTooltip,
  type BibtexHoverInfo,
  type BibtexEntryHoverInfo,
  type BibtexFieldHoverInfo
} from "./hover";
export { defaultBibtexMessages, type BibtexMessages } from "./messages";
export { localizedBibtexMessages } from "./localization";
export {
  fieldRequirements,
  ignoredFields,
  validEntryTypes,
  validFieldNames,
  type FieldAlternative,
  type FieldRequirement
} from "./schema";
export {
  collectDocumentValues,
  findTopLevelAndSeparators,
  splitAuthors,
  type DocumentValues
} from "./documentValues";
export { parser } from "./parser";
