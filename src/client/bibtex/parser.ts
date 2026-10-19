/* Derived from TeXlyre/codemirror-lang-bib (MIT). See LICENSE. */

import {
  delimitedIndent, foldInside, foldNodeProp, HighlightStyle, indentNodeProp, LRLanguage,
  type TreeIndentContext
} from "@codemirror/language";
import { styleTags, tags } from "@lezer/highlight";
import { parser as generatedParser } from "./generatedParser.mjs";

const bracedIndent = delimitedIndent({ closing: "}", align: false });
const parenthesizedIndent = delimitedIndent({ closing: ")", align: false });

function entryIndent(context: TreeIndentContext) {
  return context.node.getChild("EntryParenOpen") ? parenthesizedIndent(context) : bracedIndent(context);
}

/**
 * The Lezer parser plus the CodeMirror language data TexLite needs for every
 * .bib editor: indentation, folding, semantic highlighting and line comments.
 */
export const parser = LRLanguage.define({
  name: "bibtex",
  parser: generatedParser.configure({
    props: [
      indentNodeProp.add({
        Entry: entryIndent,
        StringEntry: entryIndent,
        PreambleEntry: entryIndent,
        BracedValue: bracedIndent,
        NestedBracedValue: bracedIndent
      }),
      foldNodeProp.add({
        Entry: foldInside,
        StringEntry: foldInside,
        PreambleEntry: foldInside,
        CommentBracedBlock: foldInside,
        CommentParenBlock: foldInside,
        BracedValue: foldInside
      }),
      styleTags({
        EntryType: tags.definitionKeyword,
        StringEntryType: tags.definitionKeyword,
        PreambleEntryType: tags.definitionKeyword,
        CommentEntryType: tags.definitionKeyword,
        EntryKey: tags.atom,
        FieldName: tags.propertyName,
        StringName: tags.propertyName,
        StringRef: tags.variableName,
        Number: tags.number,
        Concat: tags.operator,
        BracedValue: tags.string,
        QuotedValue: tags.string,
        NestedBracedValue: tags.special(tags.string),
        Command: tags.macroName,
        Escape: tags.escape,
        LineComment: tags.lineComment,
        CommentEntry: tags.blockComment,
        CommentBracedBlock: tags.blockComment,
        CommentParenBlock: tags.blockComment
      })
    ]
  }),
  languageData: {
    commentTokens: { line: "%" },
    indentOnInput: /^\s*[})]$/,
    closeBrackets: { brackets: ["{", "\""] }
  }
});

/**
 * Keep BibTeX's embedded TeX control words visually distinct from prose and
 * use a warm accent for protected nested groups. These colors follow the
 * workspace's existing blue/green palette while preserving the default
 * CodeMirror highlighting for every other BibTeX token.
 */
export const bibtexHighlightStyle = HighlightStyle.define([
  { tag: tags.macroName, color: "var(--tl-bib-command)" },
  { tag: tags.special(tags.string), color: "var(--tl-bib-protected)" }
]);
