/* Derived from TeXlyre/codemirror-lang-bib (MIT). See LICENSE. */

import { syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import { hoverTooltip, type Tooltip } from "@codemirror/view";
import { fieldRequirements, ignoredFields, validEntryTypes, validFieldNames } from "./schema";
import { defaultBibtexMessages, type BibtexMessages } from "./messages";

export interface BibtexEntryHoverInfo {
  kind: "entry";
  entryType: string;
  from: number;
  to: number;
  requiredFields: string[];
  optionalFields: string[];
  example?: string;
}

export interface BibtexFieldHoverInfo {
  kind: "field";
  field: string;
  from: number;
  to: number;
  example?: string;
  note?: "authors" | "pages" | "month";
}

export type BibtexHoverInfo = BibtexEntryHoverInfo | BibtexFieldHoverInfo;

const entryExamples: Readonly<Record<string, string>> = {
  article: "@article{key,\n  author = {John Doe},\n  title = {Sample Article},\n  journal = {Journal Name},\n  year = {2023}\n}",
  book: "@book{key,\n  author = {Jane Smith},\n  title = {Book Title},\n  publisher = {Publisher},\n  year = {2023}\n}",
  inproceedings: "@inproceedings{key,\n  author = {Author Name},\n  title = {Paper Title},\n  booktitle = {Conference Proceedings},\n  year = {2023}\n}"
};

const fieldExamples: Readonly<Record<string, string>> = {
  author: "John Doe and Jane Smith",
  title: "A Great Discovery in Science",
  journal: "Nature",
  year: "2023",
  publisher: "Academic Press",
  booktitle: "Proceedings of the International Conference",
  editor: "John Editor and Jane Editor",
  pages: "123--145",
  volume: "42",
  number: "3",
  month: "jan",
  note: "In press",
  doi: "10.1000/182",
  url: "https://example.com/paper.pdf",
  urldate: "2023-12-01",
  address: "New York, NY",
  edition: "2nd",
  series: "Lecture Notes in Computer Science",
  school: "MIT",
  institution: "Stanford University",
  organization: "IEEE",
  type: "PhD thesis",
  howpublished: "Self-published",
  chapter: "7",
  key: "Anonymous99",
  crossref: "conf2023",
  isbn: "978-0-123456-78-9",
  issn: "1234-5678",
  keywords: "machine learning, artificial intelligence",
  abstract: "This paper presents..."
};

function requirementFields(entryType: string): { requiredFields: string[]; optionalFields: string[] } {
  const requirements = fieldRequirements[entryType];
  if (!requirements) return { requiredFields: [], optionalFields: [] };
  const requiredFields = [...requirements.required];
  for (const alternative of requirements.alternatives ?? []) {
    const fields = Array.isArray(alternative) ? alternative : alternative.fields;
    requiredFields.push(fields.join(" or "));
  }
  return { requiredFields, optionalFields: requirements.optional };
}

/**
 * Return semantic hover data without touching the DOM. Keeping this separate
 * makes the parser-backed behaviour straightforward to test and lets the UI
 * localize only the presentation layer.
 */
export function bibtexHoverInfoAt(state: EditorState, position: number, side: -1 | 0 | 1 = 1): BibtexHoverInfo | null {
  const node = syntaxTree(state).resolveInner(position, side);
  if (node.name === "EntryType") {
    const entryType = state.sliceDoc(node.from + 1, node.to).toLowerCase();
    if (!validEntryTypes.has(entryType)) return null;
    return {
      kind: "entry",
      entryType,
      from: node.from,
      to: node.to,
      ...requirementFields(entryType),
      example: entryExamples[entryType]
    };
  }
  if (node.name !== "FieldName") return null;
  const field = state.sliceDoc(node.from, node.to).toLowerCase();
  if (ignoredFields.has(field) || !validFieldNames.has(field)) return null;
  const note = field === "author" || field === "editor"
    ? "authors"
    : field === "pages"
      ? "pages"
      : field === "month"
        ? "month"
        : undefined;
  return { kind: "field", field, from: node.from, to: node.to, example: fieldExamples[field], note };
}

function appendText(parent: HTMLElement, className: string, text: string): void {
  const node = document.createElement("div");
  node.className = className;
  node.textContent = text;
  parent.appendChild(node);
}

function appendExample(parent: HTMLElement, example: string, messages: BibtexMessages): void {
  appendText(parent, "cm-bibtex-tooltip-example-label", messages.exampleLabel());
  const code = document.createElement("pre");
  code.className = "cm-bibtex-tooltip-example";
  code.textContent = example;
  parent.appendChild(code);
}

function createEntryTooltip(info: BibtexEntryHoverInfo, messages: BibtexMessages): Tooltip {
  return {
    pos: info.from,
    end: info.to,
    above: true,
    create() {
      const content = document.createElement("div");
      content.className = "cm-bibtex-tooltip";
      appendText(content, "cm-bibtex-tooltip-description", messages.entryDescription(info.entryType));
      if (info.requiredFields.length > 0) {
        appendText(content, "cm-bibtex-tooltip-required", messages.requiredFields(info.requiredFields.join(", ")));
      }
      if (info.optionalFields.length > 0) {
        appendText(content, "cm-bibtex-tooltip-optional", messages.optionalFields(info.optionalFields.join(", ")));
      }
      if (info.example) appendExample(content, info.example, messages);
      return { dom: content };
    }
  };
}

function createFieldTooltip(info: BibtexFieldHoverInfo, messages: BibtexMessages): Tooltip {
  return {
    pos: info.from,
    end: info.to,
    above: true,
    create() {
      const content = document.createElement("div");
      content.className = "cm-bibtex-tooltip";
      appendText(content, "cm-bibtex-tooltip-field-name", info.field);
      appendText(content, "cm-bibtex-tooltip-description", messages.fieldDescription(info.field));
      if (info.example) appendText(content, "cm-bibtex-tooltip-example-inline", `${messages.exampleLabel()}: ${info.example}`);
      if (info.note === "authors") appendText(content, "cm-bibtex-tooltip-note", `${messages.noteLabel()}: ${messages.authorsNote()}`);
      if (info.note === "pages") appendText(content, "cm-bibtex-tooltip-note", `${messages.noteLabel()}: ${messages.pagesNote()}`);
      if (info.note === "month") appendText(content, "cm-bibtex-tooltip-note", `${messages.noteLabel()}: ${messages.monthNote()}`);
      return { dom: content };
    }
  };
}

export function createBibtexHoverTooltip(messages: BibtexMessages = defaultBibtexMessages) {
  return hoverTooltip((view, position, side) => {
    const info = bibtexHoverInfoAt(view.state, position, side);
    if (!info) return null;
    return info.kind === "entry"
      ? createEntryTooltip(info, messages)
      : createFieldTooltip(info, messages);
  });
}

export const bibtexHoverTooltip = createBibtexHoverTooltip();
