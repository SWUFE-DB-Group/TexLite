/* Derived from TeXlyre/codemirror-lang-bib (MIT). See LICENSE. */
// src/completion.ts
import { Completion, CompletionContext, CompletionResult, snippetCompletion } from '@codemirror/autocomplete';
import { syntaxTree } from '@codemirror/language';
import { SyntaxNode } from '@lezer/common';
import { fieldRequirements, validFieldNames } from './schema';
import {
  collectDocumentValues,
  DocumentValues,
  findTopLevelAndSeparators
} from './documentValues';

export const entryTypes: readonly string[] = [
  'article', 'book', 'booklet', 'conference', 'inbook', 'incollection',
  'inproceedings', 'manual', 'mastersthesis', 'misc', 'online', 'phdthesis',
  'proceedings', 'techreport', 'unpublished', 'webpage'
];

export const fieldNames: readonly string[] = Array.from(validFieldNames);

export const monthAbbreviations: readonly string[] = [
  'jan', 'feb', 'mar', 'apr', 'may', 'jun',
  'jul', 'aug', 'sep', 'oct', 'nov', 'dec'
];

export const journalAbbreviations: readonly string[] = [
  'Nature', 'Science', 'Cell', 'PNAS', 'J. Am. Chem. Soc.',
  'Phys. Rev. Lett.', 'IEEE Trans.', 'ACM Trans.', 'Commun. ACM'
];

export const snippets: readonly Completion[] = [
  snippetCompletion(
    '@article{#{key},\n\tauthor = {#{author}},\n\ttitle = {#{title}},\n\tjournal = {#{journal}},\n\tyear = {#{year}},\n\tvolume = {#{volume}},\n\tnumber = {#{number}},\n\tpages = {#{pages}}\n}',
    { label: '@article', type: 'keyword', detail: 'Journal article' }
  ),
  snippetCompletion(
    '@book{#{key},\n\tauthor = {#{author}},\n\ttitle = {#{title}},\n\tpublisher = {#{publisher}},\n\tyear = {#{year}},\n\taddress = {#{address}}\n}',
    { label: '@book', type: 'keyword', detail: 'Book' }
  ),
  snippetCompletion(
    '@inproceedings{#{key},\n\tauthor = {#{author}},\n\ttitle = {#{title}},\n\tbooktitle = {#{booktitle}},\n\tyear = {#{year}},\n\tpages = {#{pages}}\n}',
    { label: '@inproceedings', type: 'keyword', detail: 'Conference paper' }
  ),
  snippetCompletion(
    '@incollection{#{key},\n\tauthor = {#{author}},\n\ttitle = {#{title}},\n\tbooktitle = {#{booktitle}},\n\teditor = {#{editor}},\n\tpublisher = {#{publisher}},\n\tyear = {#{year}},\n\tpages = {#{pages}}\n}',
    { label: '@incollection', type: 'keyword', detail: 'Book chapter' }
  ),
  snippetCompletion(
    '@phdthesis{#{key},\n\tauthor = {#{author}},\n\ttitle = {#{title}},\n\tschool = {#{school}},\n\tyear = {#{year}}\n}',
    { label: '@phdthesis', type: 'keyword', detail: 'PhD thesis' }
  ),
  snippetCompletion(
    '@mastersthesis{#{key},\n\tauthor = {#{author}},\n\ttitle = {#{title}},\n\tschool = {#{school}},\n\tyear = {#{year}}\n}',
    { label: '@mastersthesis', type: 'keyword', detail: 'Master\'s thesis' }
  ),
  // Keep the explicit BibLaTeX convenience template available for projects
  // that use it, while the core templates above stay BibTeX-compatible.
  snippetCompletion(
    '@online{#{key},\n\tauthor = {#{author}},\n\ttitle = {#{title}},\n\turl = {#{url}},\n\turldate = {#{urldate}},\n\tyear = {#{year}}\n}',
    { label: '@online', type: 'keyword', detail: 'Online resource (BibLaTeX)' }
  ),
  snippetCompletion(
    '@misc{#{key},\n\ttitle = {#{title}},\n\tauthor = {#{author}},\n\tyear = {#{year}},\n\tnote = {#{note}}\n}',
    { label: '@misc', type: 'keyword', detail: 'Miscellaneous' }
  ),
  snippetCompletion(
    '@manual{#{key},\n\ttitle = {#{title}},\n\tauthor = {#{author}},\n\torganization = {#{organization}},\n\tyear = {#{year}}\n}',
    { label: '@manual', type: 'keyword', detail: 'Manual' }
  ),
  snippetCompletion(
    '@techreport{#{key},\n\tauthor = {#{author}},\n\ttitle = {#{title}},\n\tinstitution = {#{institution}},\n\tyear = {#{year}},\n\tnumber = {#{number}}\n}',
    { label: '@techreport', type: 'keyword', detail: 'Technical report' }
  )
];

const VALUE_NODES = new Set(['Value', 'ValueAtom', 'BracedValue', 'QuotedValue', 'Number', 'StringRef']);
const VALUE_FIELDS_FROM_DOC: Record<string, keyof Pick<DocumentValues,
  'authors' | 'editors' | 'journals' | 'publishers' | 'schools' |
  'institutions' | 'organizations' | 'addresses' | 'years'>> = {
  author: 'authors',
  editor: 'editors',
  journal: 'journals',
  journaltitle: 'journals',
  shortjournal: 'journals',
  publisher: 'publishers',
  school: 'schools',
  institution: 'institutions',
  organization: 'organizations',
  address: 'addresses',
  location: 'addresses',
  year: 'years',
  date: 'years',
  origyear: 'years'
};

function findAncestor(node: SyntaxNode, name: string): SyntaxNode | null {
  let n: SyntaxNode | null = node;
  while (n) {
    if (n.name === name) return n;
    n = n.parent;
  }
  return null;
}

function findAncestorIn(node: SyntaxNode, names: Set<string>): SyntaxNode | null {
  let n: SyntaxNode | null = node;
  while (n) {
    if (names.has(n.name)) return n;
    n = n.parent;
  }
  return null;
}

function findValueAtom(node: SyntaxNode): SyntaxNode | null {
  const atomNames = new Set(['BracedValue', 'QuotedValue', 'Number', 'StringRef']);
  let n: SyntaxNode | null = node;
  while (n) {
    if (atomNames.has(n.name)) return n;
    if (n.name === 'Value' || n.name === 'Field' || n.name === 'Entry') return null;
    n = n.parent;
  }
  return null;
}

function getEnclosingFieldName(node: SyntaxNode, doc: { sliceString(from: number, to: number): string }): string | null {
  const field = findAncestor(node, 'Field');
  if (!field) return null;
  const nameNode = field.getChild('FieldName');
  if (!nameNode) return null;
  return doc.sliceString(nameNode.from, nameNode.to).toLowerCase();
}

function getEnclosingEntryType(node: SyntaxNode, doc: { sliceString(from: number, to: number): string }): string | null {
  const entry = findAncestor(node, 'Entry');
  if (!entry) return null;
  const typeNode = entry.getChild('EntryType');
  if (!typeNode) return null;
  return doc.sliceString(typeNode.from, typeNode.to).replace(/^@/, '').toLowerCase();
}

function getPresentFieldNames(node: SyntaxNode, doc: { sliceString(from: number, to: number): string }): Set<string> {
  const present = new Set<string>();
  const entry = findAncestor(node, 'Entry');
  if (!entry) return present;
  for (const field of entry.getChildren('Field')) {
    const nameNode = field.getChild('FieldName');
    if (nameNode) present.add(doc.sliceString(nameNode.from, nameNode.to).toLowerCase());
  }
  return present;
}

function hasFollowingFieldAssignment(
  doc: { sliceString(from: number, to: number): string },
  name: SyntaxNode,
  field: SyntaxNode
): boolean {
  // `%` starts a BibTeX line comment. It is valid to put one between a field
  // name and its equals sign, so whitespace alone is not enough here.
  return /^(?:\s|%[^\n]*(?:\n|$))*=/.test(doc.sliceString(name.to, field.to));
}

function escapeQuotedBibtexLiteral(value: string): string {
  let escaped = "";
  let precedingBackslashes = 0;
  for (const character of value) {
    if (character === '"' && precedingBackslashes % 2 === 0) escaped += "\\";
    escaped += character;
    precedingBackslashes = character === "\\" ? precedingBackslashes + 1 : 0;
  }
  return escaped;
}

function completeEntryType(context: CompletionContext): CompletionResult | null {
  const match = context.matchBefore(/@[a-zA-Z]*/);
  if (!match || (match.from === match.to && !context.explicit)) return null;

  const lineStart = context.state.doc.lineAt(match.from).from;
  const before = context.state.sliceDoc(lineStart, match.from).trim();
  const isLineStart = before === '';

  const simple: Completion[] = entryTypes.map(type => ({
    label: '@' + type, type: 'keyword', apply: '@' + type, boost: 1
  }));
  const options: Completion[] = isLineStart
    ? [...simple, ...snippets.map(s => ({ ...s, boost: 0.5 }))]
    : simple;

  return { from: match.from, options, validFor: /^@?[a-zA-Z]*$/ };
}

function completeFieldName(
  context: CompletionContext,
  inside: SyntaxNode
): CompletionResult | null {
  const match = context.matchBefore(/[a-zA-Z_]*/);
  if (!match) return null;

  const doc = context.state.doc;
  const present = getPresentFieldNames(inside, doc);
  const field = findAncestor(inside, 'Field');
  const currentName = field?.getChild('FieldName') ?? null;
  // A Field node is also created while a new field name is being typed. Only
  // treat it as an existing field when an equals sign follows its name. This
  // lets a new `jou` expand to `journal = {value}`, while editing
  // `jou = {Old}` only replaces the name itself.
  const isAssignedFieldName = Boolean(
    currentName && context.pos >= currentName.from && context.pos <= currentName.to &&
    hasFollowingFieldAssignment(doc, currentName, field!)
  );
  if (isAssignedFieldName && currentName) {
    present.delete(doc.sliceString(currentName.from, currentName.to).toLowerCase());
  }
  const entryType = getEnclosingEntryType(inside, doc);
  const requirements = entryType ? fieldRequirements[entryType] : undefined;

  const requiredSet = new Set(requirements?.required ?? []);
  const optionalSet = new Set(requirements?.optional ?? []);
  if (requirements?.alternatives) {
    for (const alt of requirements.alternatives) {
      const fields = Array.isArray(alt) ? alt : alt.fields;
      for (const f of fields) requiredSet.add(f);
    }
  }

  const options: Completion[] = [];
  for (const name of fieldNames) {
    if (present.has(name.toLowerCase())) continue;
    let boost = 0.5;
    if (requiredSet.has(name)) boost = 2;
    else if (optionalSet.has(name)) boost = 1;
    options.push(isAssignedFieldName
      ? { label: name, type: 'property', apply: name, boost }
      : snippetCompletion(`${name} = {\${value}}`, {
        label: name,
        type: 'property',
        boost
      }));
  }

  return {
    from: isAssignedFieldName && currentName ? currentName.from : match.from,
    to: isAssignedFieldName && currentName ? currentName.to : undefined,
    options,
    validFor: /^[a-zA-Z_]*$/
  };
}

function completeFieldValue(
  context: CompletionContext,
  inside: SyntaxNode
): CompletionResult | null {
  const doc = context.state.doc;
  const fieldName = getEnclosingFieldName(inside, doc);
  if (!fieldName) return null;

  const isPersonField = fieldName === 'author' || fieldName === 'editor';
  const atom = findValueAtom(inside);

  if (isPersonField && (!atom || atom.name !== 'BracedValue' && atom.name !== 'QuotedValue')) {
    return null;
  }

  let from: number;
  let to = context.pos;
  let followsPersonSeparator = false;
  if (isPersonField && atom) {
    const innerStart = atom.from + 1;
    const innerEnd = atom.to - (doc.sliceString(atom.to - 1, atom.to) === (atom.name === 'BracedValue' ? '}' : '"') ? 1 : 0);
    if (context.pos < innerStart || context.pos > innerEnd) return null;

    const separators = findTopLevelAndSeparators(doc.sliceString(innerStart, innerEnd));
    const cursor = context.pos - innerStart;
    const previous = [...separators].reverse().find((separator) => separator.to <= cursor);
    const next = separators.find((separator) => separator.from >= cursor);
    followsPersonSeparator = Boolean(previous);
    from = innerStart + (previous?.to ?? 0);
    to = innerStart + (next?.from ?? innerEnd - innerStart);
  } else if (atom && (atom.name === 'BracedValue' || atom.name === 'QuotedValue')) {
    const innerStart = atom.from + 1;
    const innerEnd = atom.to - (doc.sliceString(atom.to - 1, atom.to) === (atom.name === 'BracedValue' ? '}' : '"') ? 1 : 0);
    from = innerStart;
    to = innerEnd;
  } else if (atom) {
    from = atom.from;
    to = atom.to;
  } else {
    const match = context.matchBefore(/[A-Za-z0-9_:.\-/]*/);
    from = match ? match.from : context.pos;
  }

  const docValues = collectDocumentValues(context.state);
  const options: Completion[] = [];
  const seen = new Set<string>();
  const preservesDelimiter = atom?.name === 'BracedValue' || atom?.name === 'QuotedValue';
  const shouldUseBareValue = (label: string) =>
    fieldName === 'month' && monthAbbreviations.includes(label.toLowerCase());
  const add = (label: string, type: string, boost = 1, isStringMacro = false) => {
    if (!label || seen.has(label)) return;
    seen.add(label);
    // Values already inside braces or quotes retain their delimiter. A bare
    // identifier is valid BibTeX syntax only for a number or a string macro;
    // document values such as journal names must become a braced literal.
    const apply = atom?.name === 'QuotedValue'
      ? escapeQuotedBibtexLiteral(label)
      : preservesDelimiter || shouldUseBareValue(label) || isStringMacro
        ? label
        : `{${label}}`;
    options.push({ label, type, apply, boost });
  };

  if (!isPersonField && !preservesDelimiter) {
    for (const macro of docValues.stringMacros) add(macro, 'constant', 2.5, true);
  }

  const bucket = VALUE_FIELDS_FROM_DOC[fieldName];
  if (bucket) {
    for (const v of docValues[bucket]) add(v, 'text', 2);
  }

  if (!isPersonField) {
    const sameField = docValues.byField.get(fieldName);
    if (sameField) {
      for (const v of sameField) add(v, 'text', 1.5);
    }
  }

  if (fieldName === 'month') {
    for (const m of monthAbbreviations) add(m, 'constant', 1);
  }
  if (fieldName === 'journal' || fieldName === 'journaltitle' || fieldName === 'shortjournal') {
    for (const j of journalAbbreviations) add(j, 'constant', 0.5);
  }
  if (fieldName === 'crossref' || fieldName === 'xref') {
    for (const k of docValues.keys) add(k, 'constant', 1);
  }

  if (options.length === 0) return null;
  const validValueText = preservesDelimiter ? /^[^"{}\n]*$/ : /^[^"{}%\n]*$/;
  return {
    from, to, options,
    // Re-query after `and` instead of filtering the previous person's
    // cached choices against the entire growing author/editor list.
    validFor: isPersonField
      ? (text) => validValueText.test(text) && findTopLevelAndSeparators(text).length === 0
        // Whitespace belongs to the separator, not the next person's
        // replacement range, including when typed after a trailing `and`.
        && (!followsPersonSeparator || !/^\s/.test(text))
      : validValueText
  };
}

export function bibtexCompletionSource(context: CompletionContext): CompletionResult | null {
  const tree = syntaxTree(context.state);
  const node = tree.resolveInner(context.pos, -1);

  // Percent signs inside literal values are not LineComment nodes. Using
  // the tree here keeps those literals editable without offering snippets
  // inside actual line comments or opaque @comment bodies.
  const lineComment = findAncestor(node, 'LineComment');
  if (lineComment && context.pos <= lineComment.to) return null;
  const commentEntry = findAncestor(node, 'CommentEntry');
  if (commentEntry) {
    const block = commentEntry.getChild('CommentBracedBlock') ?? commentEntry.getChild('CommentParenBlock');
    const close = block?.getChild(block.name === 'CommentBracedBlock' ? 'CommentBraceClose' : 'CommentParenClose');
    // At an intact closing delimiter's end, the cursor has left the
    // comment; an unfinished block must still suppress completion at EOF.
    if (context.pos < commentEntry.to || !close || close.from === close.to) return null;
  }

  const valueNode = findAncestorIn(node, VALUE_NODES);
  if (valueNode && findAncestor(valueNode, 'Field')) {
    return completeFieldValue(context, node);
  }

  // The parser deliberately accepts an incomplete `field =` while the user
  // is typing. It has no Value child yet, but completion should still offer
  // field values rather than a second field-name template.
  const field = findAncestor(node, 'Field');
  const fieldName = field?.getChild('FieldName');
  if (field && fieldName && /^\s*=\s*$/.test(context.state.sliceDoc(fieldName.to, context.pos))) {
    return completeFieldValue(context, node);
  }

  const entry = findAncestor(node, 'Entry');
  if (entry) {
    const before = context.state.sliceDoc(Math.max(0, context.pos - 1), context.pos);
    const explicitAt = context.matchBefore(/@[a-zA-Z]*$/);
    if (explicitAt) return completeEntryType(context);
    if (node.name === 'EntryKey' || node.name === 'EntryType') return null;
    if (!context.explicit && !/[a-zA-Z_,{\s]/.test(before)) return null;
    return completeFieldName(context, node);
  }

  return completeEntryType(context);
}
