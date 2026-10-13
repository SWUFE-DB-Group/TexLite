/* Derived from TeXlyre/codemirror-lang-bib (MIT). See LICENSE. */
// src/document-values.ts
import { EditorState } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import { SyntaxNode } from '@lezer/common';

export interface DocumentValues {
    authors: Set<string>;
    editors: Set<string>;
    journals: Set<string>;
    publishers: Set<string>;
    schools: Set<string>;
    institutions: Set<string>;
    organizations: Set<string>;
    addresses: Set<string>;
    years: Set<string>;
    stringMacros: Set<string>;
    keys: Set<string>;
    byField: Map<string, Set<string>>;
}

const FIELD_BUCKETS: Record<string, keyof Omit<DocumentValues, 'byField'>> = {
    author: 'authors',
    editor: 'editors',
    journal: 'journals',
    journaltitle: 'journals',
    shortjournal: 'journals',
    publisher: 'publishers',
    origpublisher: 'publishers',
    school: 'schools',
    institution: 'institutions',
    organization: 'organizations',
    address: 'addresses',
    location: 'addresses',
    origlocation: 'addresses',
    year: 'years',
    origyear: 'years'
};

/**
 * Completion can ask for document-wide values repeatedly while its popup is
 * open. CodeMirror documents are immutable, but a background parse may still
 * replace the syntax tree for the same document. Keying on both identities
 * avoids a full tree walk for ordinary completion updates without retaining
 * stale values after either kind of change.
 */
interface CachedDocumentValues {
    tree: ReturnType<typeof syntaxTree>;
    values: DocumentValues;
}

const documentValuesCache = new WeakMap<EditorState['doc'], CachedDocumentValues>();

interface TopLevelAndSeparator {
    /** Includes the whitespace that separates the preceding name from `and`. */
    from: number;
    /** Includes whitespace following `and`, when present. */
    to: number;
}

/**
 * Find BibTeX name-list separators without mistaking `and` inside a braced
 * corporate name (or an escaped TeX fragment) for a person separator.
 */
export function findTopLevelAndSeparators(text: string): TopLevelAndSeparator[] {
    const separators: TopLevelAndSeparator[] = [];
    let depth = 0;

    for (let index = 0; index < text.length; index++) {
        const character = text[index];
        if (character === '\\') {
            index++;
            continue;
        }
        if (character === '{') {
            depth++;
            continue;
        }
        if (character === '}') {
            depth = Math.max(0, depth - 1);
            continue;
        }
        if (depth !== 0 || text.slice(index, index + 3).toLowerCase() !== 'and') continue;

        const before = text[index - 1];
        const after = text[index + 3];
        // A trailing `and` is an incomplete name list while the user is
        // typing. Treat it as a separator too, so it never becomes a
        // reusable author completion.
        if (!before || !/\s/.test(before) || (after !== undefined && !/\s/.test(after))) continue;

        let from = index;
        while (from > 0 && /\s/.test(text[from - 1])) from--;
        let to = index + 3;
        while (to < text.length && /\s/.test(text[to])) to++;
        separators.push({ from, to });
        index += 2;
    }

    return separators;
}

export function splitAuthors(raw: string): string[] {
    // Completion runs against incomplete entries too. Do not turn a trailing
    // top-level `and` that a user has just typed into a reusable author name.
    const separators = findTopLevelAndSeparators(raw);
    const trailing = separators.at(-1);
    const end = trailing && raw.slice(trailing.to).trim() === '' ? trailing.from : raw.length;
    const names: string[] = [];
    let start = 0;

    for (const separator of separators) {
        if (separator.from >= end) break;
        const name = raw.slice(start, separator.from).trim();
        if (name) names.push(name);
        start = separator.to;
    }

    const finalName = raw.slice(start, end).trim();
    if (finalName) names.push(finalName);
    return names;
}

/**
 * Remove the delimiter belonging to the BibTeX value atom, but retain any
 * inner braces. In name lists, an inner pair of braces marks a corporate
 * author and must remain visible to `splitAuthors`.
 */
function unwrapValueAtom(text: string): string {
    const trimmed = text.trim();
    if (
        (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
        (trimmed.startsWith('"') && trimmed.endsWith('"'))
    ) {
        return trimmed.slice(1, -1).trim();
    }
    return trimmed;
}

export function collectDocumentValues(state: EditorState): DocumentValues {
    const tree = syntaxTree(state);
    const doc = state.doc;
    const cached = documentValuesCache.get(doc);
    if (cached?.tree === tree) return cached.values;

    const result: DocumentValues = {
        authors: new Set(), editors: new Set(), journals: new Set(),
        publishers: new Set(), schools: new Set(), institutions: new Set(),
        organizations: new Set(), addresses: new Set(), years: new Set(),
        stringMacros: new Set(),
        keys: new Set(), byField: new Map()
    };

    tree.cursor().iterate((node: { name: string; node: SyntaxNode }) => {
        if (node.name === 'StringEntry') {
            const nameNode = node.node.getChild('StringName');
            if (nameNode) result.stringMacros.add(doc.sliceString(nameNode.from, nameNode.to));
            return false;
        }
        if (node.name !== 'Entry') return;
        const entry = node.node;

        const keyNode = entry.getChild('EntryKey');
        if (keyNode) result.keys.add(doc.sliceString(keyNode.from, keyNode.to));

        for (const field of entry.getChildren('Field')) {
            const nameNode = field.getChild('FieldName');
            const valueNode = field.getChild('Value');
            if (!nameNode || !valueNode) continue;

            // Macro references (including concatenations) are expressions,
            // not literal field text. Offer defined macros separately in a
            // bare value context rather than reusing `journal = venue` as
            // the unrelated literal `journal = {venue}`.
            if (valueNode.getChild('Concat') || valueNode.getChild('ValueAtom')?.getChild('StringRef')) continue;

            const name = doc.sliceString(nameNode.from, nameNode.to).toLowerCase();
            const value = unwrapValueAtom(doc.sliceString(valueNode.from, valueNode.to));
            if (!value) continue;

            if (!result.byField.has(name)) result.byField.set(name, new Set());
            result.byField.get(name)!.add(value);

            const bucket = FIELD_BUCKETS[name];
            if (bucket === 'authors' || bucket === 'editors') {
                for (const person of splitAuthors(value)) result[bucket].add(person);
            } else if (bucket) {
                result[bucket].add(value);
            }
        }
        return false;
    });

    documentValuesCache.set(doc, { tree, values: result });
    return result;
}
