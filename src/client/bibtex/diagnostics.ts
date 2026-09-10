/* Derived from TeXlyre/codemirror-lang-bib (MIT). See LICENSE. */
// src/linter.ts
import { Diagnostic } from '@codemirror/lint';
import { EditorView } from '@codemirror/view';
import { Text } from '@codemirror/state';
import { syntaxTree, ensureSyntaxTree } from '@codemirror/language';
import { SyntaxNode, Tree } from '@lezer/common';
import { splitAuthors } from './documentValues';
import { defaultBibtexMessages, type BibtexMessages } from './messages';

import {
  ignoredFields,
  validEntryTypes,
  validFieldNames,
  fieldRequirements,
  FieldRequirement
} from './schema';

export interface BibtexLinterOptions {
  checkRequiredFields?: boolean;
  checkUnknownFields?: boolean;
  checkDuplicateKeys?: boolean;
  checkFieldSyntax?: boolean;
  checkEntryTypes?: boolean;
  messages?: BibtexMessages;
}

const DEFAULTS: Required<Omit<BibtexLinterOptions, "messages">> = {
  checkRequiredFields: true,
  checkUnknownFields: true,
  checkDuplicateKeys: true,
  checkFieldSyntax: true,
  checkEntryTypes: true
};

const PARSE_BUDGET_MS = 500;

interface KeyOccurrence {
  from: number;
  to: number;
  flagged: boolean;
}

function reportSyntaxErrors(tree: Tree, diagnostics: Diagnostic[], messages: BibtexMessages): void {
  const reported = new Set<number>();
  tree.cursor().iterate(node => {
    if (!node.type.isError) return;
    if (reported.has(node.from)) return;
    reported.add(node.from);
    const to = node.to > node.from ? node.to : node.from + 1;
    diagnostics.push({
      from: node.from,
      to,
      severity: 'error',
      message: messages.syntaxError(),
      source: 'BibTeX'
    });
  });
}

function reportDuplicatePersons(field: CollectedField, doc: Text, diagnostics: Diagnostic[], messages: BibtexMessages): void {
  const value = stripBracesAndQuotes(doc.sliceString(field.valueFrom, field.valueTo));
  const seen = new Set<string>();
  for (const person of splitAuthors(value)) {
    const key = person.toLowerCase();
    if (seen.has(key)) {
      diagnostics.push({
        from: field.valueFrom,
        to: field.valueTo,
        severity: 'warning',
        message: messages.duplicatePerson(field.name, person),
        source: 'BibTeX'
      });
    } else {
      seen.add(key);
    }
  }
}

export function bibtexLinter(options: BibtexLinterOptions = {}) {
  const { messages = defaultBibtexMessages, ...configured } = options;
  const opts: Required<Omit<BibtexLinterOptions, "messages">> = { ...DEFAULTS, ...configured };

  return (view: EditorView): Diagnostic[] => {
    const diagnostics: Diagnostic[] = [];
    const doc = view.state.doc;
    const tree = ensureSyntaxTree(view.state, doc.length, PARSE_BUDGET_MS) ?? syntaxTree(view.state);
    const treeComplete = tree.length >= doc.length;
    const seenKeys = new Map<string, KeyOccurrence>();

    tree.cursor().iterate(node => {
      if (node.name === 'Entry') {
        checkEntry(node.node, doc, diagnostics, seenKeys, opts, treeComplete, messages);
        return false;
      }
    });

    if (opts.checkFieldSyntax && treeComplete) {
      reportSyntaxErrors(tree, diagnostics, messages);
    }

    return diagnostics;
  };
}

function checkEntry(
  entry: SyntaxNode,
  doc: Text,
  diagnostics: Diagnostic[],
  seenKeys: Map<string, KeyOccurrence>,
  opts: Required<Omit<BibtexLinterOptions, "messages">>,
  treeComplete: boolean,
  messages: BibtexMessages
): void {
  const typeNode = entry.getChild('EntryType');
  const keyNode = entry.getChild('EntryKey');

  if (!typeNode) return;

  const rawType = doc.sliceString(typeNode.from, typeNode.to);
  const entryType = rawType.replace(/^@/, '').toLowerCase();

  if (opts.checkEntryTypes && !validEntryTypes.has(entryType)) {
    diagnostics.push({
      from: typeNode.from,
      to: typeNode.to,
      severity: 'warning',
      message: messages.unknownEntryType(entryType),
      source: 'BibTeX'
    });
  }

  if (opts.checkDuplicateKeys && keyNode) {
    const key = doc.sliceString(keyNode.from, keyNode.to).trim();
    if (key) {
      const existing = seenKeys.get(key);
      if (existing) {
        diagnostics.push({
          from: keyNode.from,
          to: keyNode.to,
          severity: 'error',
          message: messages.duplicateEntryKey(key),
          source: 'BibTeX'
        });
        if (!existing.flagged) {
          diagnostics.push({
            from: existing.from,
            to: existing.to,
            severity: 'error',
            message: messages.duplicateEntryKey(key),
            source: 'BibTeX'
          });
          existing.flagged = true;
        }
      } else {
        seenKeys.set(key, { from: keyNode.from, to: keyNode.to, flagged: false });
      }
    }
  }

  const fields = collectFields(entry, doc);
  const presentNames = new Set(fields.map(f => f.name.toLowerCase()));

  if (opts.checkRequiredFields && treeComplete) {
    const requirements = fieldRequirements[entryType];
    if (requirements) {
      const crossRefField = ['crossref', 'xref', 'xdata', 'related']
        .find(name => presentNames.has(name));
      reportMissingRequired(entry, presentNames, requirements, diagnostics, crossRefField, messages);
    }
  }

  if (opts.checkUnknownFields || opts.checkFieldSyntax || opts.checkDuplicateKeys) {
    const seenFieldNames = new Map<string, number>();
    for (const field of fields) {
      const lower = field.name.toLowerCase();

      if (ignoredFields.has(lower)) continue;

      if (opts.checkDuplicateKeys) {
        if (seenFieldNames.has(lower)) {
          diagnostics.push({
            from: field.nameFrom,
            to: field.nameTo,
            severity: 'warning',
            message: messages.duplicateField(field.name),
            source: 'BibTeX'
          });
        } else {
          seenFieldNames.set(lower, field.nameFrom);
        }

        if (lower === 'author' || lower === 'editor') {
          reportDuplicatePersons(field, doc, diagnostics, messages);
        }
      }

      if (opts.checkUnknownFields && !validFieldNames.has(lower)) {
        diagnostics.push({
          from: field.nameFrom,
          to: field.nameTo,
          severity: 'warning',
          message: messages.unknownField(field.name),
          source: 'BibTeX'
        });
      }

      if (opts.checkFieldSyntax) {
        if (field.hasError) {
          diagnostics.push({
            from: field.valueFrom,
            to: field.valueTo,
            severity: 'error',
            message: messages.invalidFieldValue(field.name),
            source: 'BibTeX'
          });
        } else if (field.isEmpty) {
          diagnostics.push({
            from: field.valueFrom,
            to: field.valueTo,
            severity: 'warning',
            message: messages.emptyFieldValue(field.name),
            source: 'BibTeX'
          });
        }
      }
    }
  }
}

interface CollectedField {
  name: string;
  nameFrom: number;
  nameTo: number;
  valueFrom: number;
  valueTo: number;
  isEmpty: boolean;
  hasError: boolean;
}

function collectFields(entry: SyntaxNode, doc: Text): CollectedField[] {
  const fields: CollectedField[] = [];

  for (const fieldNode of entry.getChildren('Field')) {
    const nameNode = fieldNode.getChild('FieldName');
    const valueNode = fieldNode.getChild('Value');
    if (!nameNode) continue;

    const valueFrom = valueNode ? valueNode.from : nameNode.to;
    const valueTo = valueNode ? valueNode.to : nameNode.to;
    const valueText = valueNode ? doc.sliceString(valueNode.from, valueNode.to) : '';

    fields.push({
      name: doc.sliceString(nameNode.from, nameNode.to),
      nameFrom: nameNode.from,
      nameTo: nameNode.to,
      valueFrom,
      valueTo,
      isEmpty: !valueNode || stripBracesAndQuotes(valueText).trim() === '',
      hasError: valueNode ? hasErrorNode(valueNode) : false
    });
  }

  return fields;
}

function reportMissingRequired(
  entry: SyntaxNode,
  present: Set<string>,
  requirements: FieldRequirement,
  diagnostics: Diagnostic[],
  crossRefField: string | undefined,
  messages: BibtexMessages
): void {
  const missingErrors: string[] = [];
  const missingWarnings: string[] = [];

  for (const required of requirements.required) {
    if (!present.has(required)) missingErrors.push(required);
  }

  if (requirements.alternatives) {
    for (const alt of requirements.alternatives) {
      const fields = Array.isArray(alt) ? alt : alt.fields;
      const severity = Array.isArray(alt) ? 'error' : alt.severity;
      if (!fields.some(name => present.has(name))) {
        const label = fields.join(' or ');
        if (severity === 'warning') {
          missingWarnings.push(label);
        } else {
          missingErrors.push(label);
        }
      }
    }
  }

  if (crossRefField) {
    if (missingErrors.length > 0 || missingWarnings.length > 0) {
      const all = [...missingErrors, ...missingWarnings];
      diagnostics.push({
        from: entry.from,
        to: entry.to,
        severity: 'info',
        message: messages.verifyInheritedFields(crossRefField, all.join(', ')),
        source: 'BibTeX'
      });
    }
    return;
  }

  if (missingErrors.length > 0) {
    diagnostics.push({
      from: entry.from,
      to: entry.to,
      severity: 'error',
      message: messages.missingRequiredFields(missingErrors.join(', ')),
      source: 'BibTeX'
    });
  }

  if (missingWarnings.length > 0) {
    diagnostics.push({
      from: entry.from,
      to: entry.to,
      severity: 'warning',
      message: messages.missingRecommendedFields(missingWarnings.join(', ')),
      source: 'BibTeX'
    });
  }
}

function hasErrorNode(node: SyntaxNode): boolean {
  let found = false;
  node.cursor().iterate(child => {
    if (found) return false;
    if (child.type.isError) {
      found = true;
      return false;
    }
  });
  return found;
}

function stripBracesAndQuotes(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    return trimmed.slice(1, -1);
  }
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}
