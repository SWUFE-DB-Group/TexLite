import { StreamLanguage, type StreamParser, type StringStream } from "@codemirror/language";
import { stex } from "@codemirror/legacy-modes/mode/stex";
import { inlineLatexLiteralEnd, isLatexLiteralEnvironment, literalEnvironmentEnd } from "./latexLiterals";

const bracketCharacters = new Set(["(", ")", "[", "]", "{", "}"]);
const numberBeforeComment = /^\d[\w.]*(?=%)/;

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

function consumeNumberBeforeComment(stream: StringStream): boolean {
  const match = stream.match(numberBeforeComment);
  return Boolean(match && typeof match !== "boolean");
}

/**
 * `stex.copyState` only copies its command stack array. The stack entries are
 * mutable plugins (for example `\\documentclass` increments `bracketNo`), so
 * sharing them between CodeMirror's incremental parsing branches can corrupt
 * the older branch. Preserve each plugin's prototype and own methods while
 * giving its mutable fields an independent object.
 */
function copyStexState(state: unknown): unknown {
  const copied = stex.copyState?.(state) ?? state;
  if (!copied || typeof copied !== "object") return copied;
  const legacy = copied as { cmdState?: unknown };
  if (!Array.isArray(legacy.cmdState)) return copied;
  return {
    ...legacy,
    cmdState: legacy.cmdState.map((plugin) => {
      if (!plugin || typeof plugin !== "object") return plugin;
      return Object.assign(Object.create(Object.getPrototypeOf(plugin)), plugin);
    })
  };
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
      stexState: copyStexState(state.stexState),
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
    // stex consumes '%' as part of a number-like token (for example, `100%`).
    // In TeX that percent starts a comment, so leave it for the next token call.
    if (consumeNumberBeforeComment(stream)) return "atom";
    const from = stream.pos;
    const style = stex.token(stream, state.stexState);
    const token = stream.string.slice(from, stream.pos);
    return bracketCharacters.has(token) ? "bracket" : style;
  }
};

export const latexLanguage = StreamLanguage.define(latexStream);

// BibTeX lives in a self-contained internal CodeMirror 6 module. Keeping this
// re-export preserves the editor's existing language boundary while avoiding a
// separately published language package and duplicate generic extensions.
export {
  bibtexBracketMatching,
  bibtexCompletionSource,
  createBibtexEditorExtensions,
  bibtexEditorExtensions,
  bibtexHoverTooltip,
  bibtexLanguage,
  bibtexLinter,
  localizedBibtexMessages
} from "./bibtex";
