/* Derived from TeXlyre/codemirror-lang-bib (MIT). See LICENSE. */

/**
 * UI text is injected rather than embedded in the parser, completion, or
 * diagnostics modules. This keeps the BibTeX engine reusable and lets
 * TexLite localize every visible message.
 */
export interface BibtexMessages {
  syntaxError(): string;
  duplicatePerson(field: string, person: string): string;
  unknownEntryType(entryType: string): string;
  duplicateEntryKey(key: string): string;
  duplicateField(field: string): string;
  unknownField(field: string): string;
  invalidFieldValue(field: string): string;
  emptyFieldValue(field: string): string;
  verifyInheritedFields(field: string, fields: string): string;
  missingRequiredFields(fields: string): string;
  missingRecommendedFields(fields: string): string;
  entryDescription(entryType: string): string;
  fieldDescription(field: string): string;
  requiredFields(fields: string): string;
  optionalFields(fields: string): string;
  exampleLabel(): string;
  noteLabel(): string;
  authorsNote(): string;
  pagesNote(): string;
  monthNote(): string;
}

/** Default English strings for standalone module consumers and unit tests. */
export const defaultBibtexMessages: BibtexMessages = {
  syntaxError: () => "Syntax error",
  duplicatePerson: (field, person) => `Duplicate name in ${field}: ${person}`,
  unknownEntryType: (entryType) => `Unknown entry type: @${entryType}`,
  duplicateEntryKey: (key) => `Duplicate entry key: ${key}`,
  duplicateField: (field) => `Duplicate field '${field}' in entry`,
  unknownField: (field) => `Unknown field: ${field}`,
  invalidFieldValue: (field) => `Syntax error in value for field '${field}'`,
  emptyFieldValue: (field) => `Empty value for field '${field}'`,
  verifyInheritedFields: (field, fields) => `Verify '${field}' provides: ${fields}`,
  missingRequiredFields: (fields) => `Missing required fields: ${fields}`,
  missingRecommendedFields: (fields) => `Recommended fields missing: ${fields}`,
  entryDescription: (entryType) => `BibTeX entry type @${entryType}.`,
  fieldDescription: (field) => `${field} is a BibTeX field.`,
  requiredFields: (fields) => `Required: ${fields}`,
  optionalFields: (fields) => `Optional: ${fields}`,
  exampleLabel: () => "Example",
  noteLabel: () => "Note",
  authorsNote: () => "Use “and” to separate multiple authors or editors.",
  pagesNote: () => "Use a double dash (--) for a page range.",
  monthNote: () => "Use a three-letter abbreviation without quotes."
};
