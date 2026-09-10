import type { TFunction } from "i18next";
import type { BibtexMessages } from "./messages";

/** Build localized visible text while keeping BibTeX parsing independent of i18n. */
export function localizedBibtexMessages(t: TFunction): BibtexMessages {
  return {
    syntaxError: () => t("bibtex.diagnostics.syntaxError"),
    duplicatePerson: (field, person) => t("bibtex.diagnostics.duplicatePerson", { field, person }),
    unknownEntryType: (entryType) => t("bibtex.diagnostics.unknownEntryType", { entryType }),
    duplicateEntryKey: (key) => t("bibtex.diagnostics.duplicateEntryKey", { key }),
    duplicateField: (field) => t("bibtex.diagnostics.duplicateField", { field }),
    unknownField: (field) => t("bibtex.diagnostics.unknownField", { field }),
    invalidFieldValue: (field) => t("bibtex.diagnostics.invalidFieldValue", { field }),
    emptyFieldValue: (field) => t("bibtex.diagnostics.emptyFieldValue", { field }),
    verifyInheritedFields: (field, fields) => t("bibtex.diagnostics.verifyInheritedFields", { field, fields }),
    missingRequiredFields: (fields) => t("bibtex.diagnostics.missingRequiredFields", { fields }),
    missingRecommendedFields: (fields) => t("bibtex.diagnostics.missingRecommendedFields", { fields }),
    entryDescription: (entryType) => t("bibtex.hover.entryDescription", { entryType: `@${entryType}` }),
    fieldDescription: (field) => t("bibtex.hover.fieldDescription", { field }),
    requiredFields: (fields) => t("bibtex.hover.requiredFields", { fields }),
    optionalFields: (fields) => t("bibtex.hover.optionalFields", { fields }),
    exampleLabel: () => t("bibtex.hover.example"),
    noteLabel: () => t("bibtex.hover.note"),
    authorsNote: () => t("bibtex.hover.authorsNote"),
    pagesNote: () => t("bibtex.hover.pagesNote"),
    monthNote: () => t("bibtex.hover.monthNote")
  };
}
