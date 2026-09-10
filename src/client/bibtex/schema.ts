/* Derived from TeXlyre/codemirror-lang-bib (MIT). See LICENSE. */
// src/fields.ts
export type FieldAlternative = string[] | { fields: string[]; severity: 'error' | 'warning' };

export interface FieldRequirement {
    required: string[];
    alternatives?: FieldAlternative[];
    optional: string[];
}

export const ignoredFields: ReadonlySet<string> = new Set([
    'remote-id',
    'external-id'
]);

export const validEntryTypes: ReadonlySet<string> = new Set([
    'article', 'book', 'mvbook', 'inbook', 'bookinbook', 'suppbook', 'booklet',
    'collection', 'mvcollection', 'incollection', 'suppcollection',
    'manual', 'misc', 'online', 'webpage', 'patent', 'periodical', 'suppperiodical',
    'proceedings', 'mvproceedings', 'inproceedings', 'conference',
    'reference', 'mvreference', 'inreference',
    'report', 'techreport', 'thesis', 'mastersthesis', 'phdthesis',
    'unpublished', 'software', 'dataset', 'letter',
    'set', 'xdata'
]);

export const validFieldNames: ReadonlySet<string> = new Set([
    'abstract', 'addendum', 'address', 'afterword', 'annotation', 'annote',
    'annotator', 'archiveprefix', 'author', 'authortype', 'bookauthor',
    'bookpagination', 'booksubtitle', 'booktitle', 'booktitleaddon',
    'chapter', 'commentator', 'crossref', 'date', 'doi', 'edition', 'editor',
    'editora', 'editorb', 'editorc', 'editortype', 'editoratype', 'editorbtype',
    'editorctype', 'eid', 'entryset', 'eprint', 'eprintclass', 'eprinttype',
    'eventdate', 'eventtitle', 'eventtitleaddon', 'execute', 'file', 'foreword',
    'gender', 'holder', 'howpublished', 'hyphenation', 'indexsorttitle',
    'indextitle', 'institution', 'introduction', 'isan', 'isbn', 'ismn', 'isrn',
    'issn', 'issue', 'issuesubtitle', 'issuetitle', 'iswc', 'journal',
    'journalsubtitle', 'journaltitle', 'key', 'keywords', 'label', 'langid',
    'langidopts', 'language', 'library', 'location', 'mainsubtitle', 'maintitle',
    'maintitleaddon', 'month', 'nameaddon', 'note', 'number', 'organization',
    'origdate', 'origlanguage', 'origlocation', 'origpublisher', 'origtitle',
    'origyear', 'options', 'pages', 'pagetotal', 'pagination', 'part',
    'presort', 'primaryclass', 'publisher', 'pubstate', 'related',
    'relatedoptions', 'relatedstring', 'relatedtype', 'reprinttitle', 'school',
    'series', 'shortauthor', 'shorteditor', 'shorthand', 'shorthandintro',
    'shortjournal', 'shortseries', 'shorttitle', 'sortkey', 'sortname',
    'sortshorthand', 'sorttitle', 'sortyear', 'subtitle', 'title', 'titleaddon',
    'translator', 'type', 'url', 'urldate', 'usera', 'userb', 'userc', 'userd',
    'usere', 'userf', 'venue', 'verba', 'verbb', 'verbc', 'version', 'volume',
    'volumes', 'xdata', 'xref', 'year'
]);

export const fieldRequirements: Record<string, FieldRequirement> = {
    article: {
        required: ['author', 'title'],
        alternatives: [
            ['date', 'year'],
            { fields: ['journaltitle', 'journal'], severity: 'warning' }
        ],
        optional: ['translator', 'editor', 'subtitle', 'titleaddon', 'volume',
            'number', 'eid', 'issue', 'pages', 'note', 'issn', 'doi', 'eprint',
            'url', 'urldate', 'series']
    },
    book: {
        required: ['title'],
        alternatives: [
            ['date', 'year'],
            { fields: ['author', 'editor'], severity: 'warning' }
        ],
        optional: ['publisher', 'location', 'address', 'edition', 'volume',
            'volumes', 'series', 'number', 'isbn', 'pagetotal', 'note', 'doi',
            'url', 'urldate', 'subtitle', 'titleaddon', 'maintitle', 'mainsubtitle',
            'translator', 'commentator', 'annotator', 'introduction', 'foreword',
            'afterword']
    },
    mvbook: {
        required: ['title', 'volumes'],
        alternatives: [['author', 'editor'], ['date', 'year']],
        optional: ['publisher', 'location', 'edition', 'series', 'number',
            'isbn', 'note', 'subtitle', 'titleaddon']
    },
    inbook: {
        required: ['title', 'booktitle'],
        alternatives: [['author', 'editor'], ['date', 'year']],
        optional: ['bookauthor', 'editor', 'pages', 'chapter', 'publisher',
            'location', 'edition', 'volume', 'series', 'number', 'maintitle',
            'note', 'doi', 'url', 'urldate']
    },
    booklet: {
        required: ['title'],
        alternatives: [['author', 'editor']],
        optional: ['howpublished', 'location', 'date', 'year', 'month', 'note', 'url']
    },
    collection: {
        required: ['title'],
        alternatives: [
            ['date', 'year'],
            { fields: ['editor'], severity: 'warning' }
        ],
        optional: ['publisher', 'location', 'edition', 'volume', 'volumes',
            'series', 'number', 'isbn', 'note', 'subtitle', 'titleaddon']
    },
    mvcollection: {
        required: ['editor', 'title'],
        alternatives: [['date', 'year']],
        optional: ['publisher', 'location', 'edition', 'volumes', 'series',
            'number', 'isbn', 'note']
    },
    incollection: {
        required: ['author', 'title', 'booktitle'],
        alternatives: [['date', 'year']],
        optional: ['editor', 'pages', 'publisher', 'location', 'edition',
            'volume', 'series', 'number', 'maintitle', 'note', 'doi', 'url']
    },
    inproceedings: {
        required: ['author', 'title', 'booktitle'],
        alternatives: [['date', 'year']],
        optional: ['editor', 'pages', 'publisher', 'organization', 'location',
            'venue', 'eventdate', 'eventtitle', 'series', 'volume', 'number',
            'note', 'doi', 'url']
    },
    conference: {
        required: ['author', 'title', 'booktitle'],
        alternatives: [['date', 'year']],
        optional: ['editor', 'pages', 'publisher', 'organization', 'location',
            'series', 'volume', 'number', 'note']
    },
    proceedings: {
        required: ['title'],
        alternatives: [['date', 'year']],
        optional: ['editor', 'publisher', 'organization', 'location', 'venue',
            'eventdate', 'eventtitle', 'series', 'volume', 'number', 'note']
    },
    manual: {
        required: ['title'],
        optional: ['author', 'editor', 'organization', 'edition', 'location',
            'date', 'year', 'month', 'note', 'url']
    },
    misc: {
        required: ['title'],
        optional: ['author', 'editor', 'howpublished', 'date', 'year', 'month',
            'note', 'url', 'urldate']
    },
    online: {
        required: ['title'],
        alternatives: [
            ['date', 'year'],
            { fields: ['url', 'doi', 'eprint'], severity: 'warning' }
        ],
        optional: ['author', 'editor', 'month', 'urldate', 'note',
            'organization', 'version']
    },
    webpage: {
        required: ['title', 'url'],
        optional: ['author', 'date', 'year', 'urldate', 'note']
    },
    patent: {
        required: ['author', 'title', 'number'],
        alternatives: [['date', 'year']],
        optional: ['holder', 'type', 'location', 'note', 'url']
    },
    periodical: {
        required: ['title'],
        alternatives: [
            ['date', 'year'],
            { fields: ['editor'], severity: 'warning' }
        ],
        optional: ['subtitle', 'issuetitle', 'issuesubtitle', 'series',
            'volume', 'number', 'issue', 'issn', 'note']
    },
    thesis: {
        required: ['author', 'title', 'type', 'institution'],
        alternatives: [['date', 'year']],
        optional: ['location', 'note', 'url', 'doi', 'school']
    },
    phdthesis: {
        required: ['author', 'title', 'school'],
        alternatives: [['date', 'year']],
        optional: ['location', 'address', 'type', 'note', 'url', 'doi', 'month']
    },
    mastersthesis: {
        required: ['author', 'title', 'school'],
        alternatives: [['date', 'year']],
        optional: ['location', 'address', 'type', 'note', 'url', 'doi', 'month']
    },
    report: {
        required: ['author', 'title', 'type', 'institution'],
        alternatives: [['date', 'year']],
        optional: ['number', 'location', 'note', 'url', 'doi']
    },
    techreport: {
        required: ['author', 'title', 'institution'],
        alternatives: [['date', 'year']],
        optional: ['type', 'number', 'location', 'address', 'note', 'url', 'month']
    },
    unpublished: {
        required: ['author', 'title'],
        alternatives: [['date', 'year']],
        optional: ['note', 'month', 'url']
    },
    dataset: {
        required: ['title'],
        alternatives: [['date', 'year']],
        optional: ['author', 'editor', 'publisher', 'version', 'doi', 'url', 'urldate', 'note']
    },
    software: {
        required: ['title'],
        alternatives: [['date', 'year']],
        optional: ['author', 'editor', 'publisher', 'version', 'url', 'urldate', 'note']
    },
    set: {
        required: ['entryset'],
        optional: []
    }
};
