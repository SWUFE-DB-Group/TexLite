import { StreamLanguage, type StreamParser, type StringStream } from "@codemirror/language";
import { linter } from "@codemirror/lint";
import { stex } from "@codemirror/legacy-modes/mode/stex";
import { tags, styleTags } from "@lezer/highlight";
import {
  bibtexBracketMatching,
  bibtexCompletionSource,
  bibtexLanguage as baseBibtexLanguage,
  bibtexLinter
} from "codemirror-lang-bib";
import { inlineLatexLiteralEnd, isLatexLiteralEnvironment, literalEnvironmentEnd } from "./latexLiterals";

const bracketCharacters = new Set(["(", ")", "[", "]", "{", "}"]);

interface LatexStreamState {
  stexState: unknown;
  literalEnvironment: string | null;
}

const literalEnvironmentBegin = /^\\begin\s*\{\s*([A-Za-z0-9@:_*.\-]+)\s*\}/;

function consumeLiteralEnvironmentBegin(stream: StringStream): string | null {
  const match = stream.match(literalEnvironmentBegin, false);
  if (!match || typeof match === "boolean" || !isLatexLiteralEnvironment(match[1])) return null;
  stream.match(literalEnvironmentBegin);
  return match[1];
}

function consumeLiteralEnvironment(stream: StringStream, name: string): string {
  const end = literalEnvironmentEnd(stream.string, stream.pos, name);
  if (!end) {
    stream.skipToEnd();
    return "string";
  }
  if (end.from > stream.pos) {
    stream.pos = end.from;
    return "string";
  }
  stream.pos = end.to;
  return "tag";
}

// The legacy stex mode is deliberately retained because it is compact and
// predictable for ordinary TeX. Its state machine does not understand raw
// literal constructs, however: a `$` inside \verb or verbatim can otherwise
// leave all later prose in math mode. The wrapper protects those constructs
// while preserving stex's established command and bracket colouring.
export const latexStream: StreamParser<LatexStreamState> = {
  name: stex.name,
  startState(indentUnit) {
    return { stexState: stex.startState?.(indentUnit) ?? {}, literalEnvironment: null };
  },
  copyState(state) {
    return {
      stexState: stex.copyState?.(state.stexState) ?? state.stexState,
      literalEnvironment: state.literalEnvironment
    };
  },
  blankLine(state, indentUnit) {
    if (!state.literalEnvironment) stex.blankLine?.(state.stexState, indentUnit);
  },
  indent(state, textAfter, context) {
    return state.literalEnvironment ? null : stex.indent?.(state.stexState, textAfter, context) ?? null;
  },
  languageData: stex.languageData,
  tokenTable: stex.tokenTable,
  mergeTokens: stex.mergeTokens,
  token(stream, state) {
    if (state.literalEnvironment) {
      const style = consumeLiteralEnvironment(stream, state.literalEnvironment);
      if (style === "tag") state.literalEnvironment = null;
      return style;
    }
    const literalEnvironment = consumeLiteralEnvironmentBegin(stream);
    if (literalEnvironment) {
      state.literalEnvironment = literalEnvironment;
      return "tag";
    }
    const inlineLiteral = inlineLatexLiteralEnd(stream.string, stream.pos);
    if (inlineLiteral !== null) {
      stream.pos = inlineLiteral;
      return "string";
    }
    const from = stream.pos;
    const style = stex.token(stream, state.stexState);
    const token = stream.string.slice(from, stream.pos);
    return bracketCharacters.has(token) ? "bracket" : style;
  }
};

export const latexLanguage = StreamLanguage.define(latexStream);

// codemirror-lang-bib provides the BibTeX grammar and incremental parser. Its
// 0.2.x grammar emits LineComment nodes without assigning their semantic
// highlight tag, so preserve comment highlighting with a parser property only.
export const bibtexLanguage = baseBibtexLanguage.configure({
  props: [styleTags({ LineComment: tags.lineComment })]
}, "bibtex");

// Use codemirror-lang-bib's parser-backed folding, diagnostics, and completion
// source. The editor owns the shared completion UI, so this deliberately does
// not use the package's all-in-one `bibtex()` helper (which would register a
// second autocompletion instance and duplicate its key bindings).
export const bibtexEditorExtensions = [
  bibtexBracketMatching,
  linter(bibtexLinter())
];

export { bibtexCompletionSource, bibtexLinter };
