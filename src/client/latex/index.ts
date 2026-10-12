import { foldInside, foldNodeProp, LRLanguage } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import type { SyntaxNode } from "@lezer/common";
import { styleTags, tags } from "@lezer/highlight";
import { parser } from "./latex.mjs";

function sectionFold(node: SyntaxNode, state: EditorState) {
  const content = node.getChild("Content");
  if (!content || content.from >= content.to) return null;
  // Keep the following heading on its own line when trailing whitespace or
  // a comment belongs to this section. No source-wide scan is needed.
  const lastLine = state.doc.lineAt(content.to);
  const trailingIndent = state.sliceDoc(lastLine.from, content.to);
  const to = lastLine.from > content.from && /^[\t ]*$/.test(trailingIndent) ? lastLine.from - 1 : content.to;
  // A skipped comment may consume the opening line's newline, putting
  // Content on the next line. The fold must still start on the clicked line.
  const from = Math.min(content.from, state.doc.lineAt(node.from).to);
  return from < to ? { from, to } : null;
}

function environmentFold(node: SyntaxNode, state: EditorState) {
  const begin = node.getChild("BeginEnv")?.getChild("EnvNameGroup");
  const end = node.getChild("EndEnv")?.getChild("EnvNameGroup");
  const content = node.getChild("Content");
  // Error recovery may insert an end marker or pair different generic
  // environments. Never fold source based on such an inferred close.
  if (!begin || !end || !content || content.from >= content.to
    || end.lastChild?.name !== "CloseBrace" || end.lastChild.from === end.lastChild.to) return null;
  const name = (group: SyntaxNode) => state.sliceDoc(group.from + 1, group.to - 1).trim();
  return name(begin) === name(end)
    ? { from: Math.min(content.from, state.doc.lineAt(node.from).to), to: content.to }
    : null;
}

// Derive generic token groups from the grammar instead of copying Overleaf's
// application-specific tree-query helpers and node properties.
const commandTokens = parser.nodeSet.types.filter((type) => /CtrlSeq$/.test(type.name)).map((type) => type.name).join(" ");
const symbolTokens = parser.nodeSet.types.filter((type) => /CtrlSym$/.test(type.name)).map((type) => type.name).join(" ");
const environmentTokens = parser.nodeSet.types.filter((type) => /EnvName$/.test(type.name)).map((type) => type.name).join(" ");

/** Structural editor parser; project symbol extraction stays independent. */
export const latexLanguage = LRLanguage.define({
  name: "latex",
  parser: parser.configure({ props: [
    foldNodeProp.add({
      Group: foldInside, NonEmptyGroup: foldInside, TextArgument: foldInside,
      DefinitionArgument: foldInside, MathArgument: foldInside,
      $Environment: environmentFold,
      $Section: sectionFold
    }),
    styleTags({
      [commandTokens]: tags.tagName,
      [symbolTokens]: tags.escape,
      [environmentTokens]: tags.attributeValue,
      "CtrlSeq Csname Begin End": tags.tagName,
      "DocumentClassCtrlSeq UsePackageCtrlSeq CiteCtrlSeq CiteStarrableCtrlSeq RefCtrlSeq RefStarrableCtrlSeq LabelCtrlSeq": tags.keyword,
      "OpenBrace CloseBrace": tags.brace,
      "OpenBracket CloseBracket": tags.squareBracket,
      "Math MathChar MathSpecialChar Number": tags.string,
      "Dollar OpenParenMath CloseParenMath OpenBracketMath CloseBracketMath": tags.string,
      "Tilde Ampersand LineBreakCtrlSym MacroParameter": tags.keyword,
      Comment: tags.comment,
      "LiteralArgContent VerbContent VerbatimContent LstInlineContent": tags.string,
      "LabelArgument/ShortTextArgument/ShortArg/... RefArgument/ShortTextArgument/ShortArg/... BibKeyArgument/ShortTextArgument/ShortArg/...": tags.attributeValue,
      "UrlArgument/LiteralArgContent": tags.url,
      "FilePathArgument/LiteralArgContent BareFilePathArgument/SpaceDelimitedLiteralArgContent": tags.attributeValue,
      "DocumentClassArgument/ShortTextArgument/ShortArg/...": tags.typeName,
      "PackageArgument/ShortTextArgument/ShortArg/...": tags.namespace,
      TrailingContent: tags.comment
    })
  ] }),
  languageData: {
    commentTokens: { line: "%" },
    closeBrackets: { brackets: ["(", "[", "{"] }
  }
});
