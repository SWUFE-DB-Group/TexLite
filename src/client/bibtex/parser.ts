/* Derived from TeXlyre/codemirror-lang-bib (MIT). See LICENSE. */

import { foldInside, foldNodeProp, indentNodeProp, LRLanguage } from "@codemirror/language";
import { styleTags, tags } from "@lezer/highlight";
import { parser as generatedParser } from "./generatedParser.mjs";

/**
 * The Lezer parser plus the CodeMirror language data TexLite needs for every
 * .bib editor: indentation, folding, semantic highlighting and line comments.
 */
export const parser = LRLanguage.define({
  name: "bibtex",
  parser: generatedParser.configure({
    props: [
      indentNodeProp.add({
        Entry: (context) => context.baseIndent + context.unit,
        StringEntry: (context) => context.baseIndent + context.unit,
        PreambleEntry: (context) => context.baseIndent + context.unit,
        BracedValue: (context) => context.baseIndent + context.unit
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
    closeBrackets: { brackets: ["{", "\""] }
  }
});
