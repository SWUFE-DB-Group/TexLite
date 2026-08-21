import { StreamLanguage, type StreamParser } from "@codemirror/language";
import { stex } from "@codemirror/legacy-modes/mode/stex";

const bracketCharacters = new Set(["(", ")", "[", "]", "{", "}"]);

// The legacy stex mode tracks command arguments, but it can mark a valid
// outer brace as an error after nested environments (for example, a
// \resizebox containing a tabular). Keep its highlighting while making every
// literal delimiter available to CodeMirror's bracket matcher.
export const latexStream: StreamParser<unknown> = {
  ...stex,
  token(stream, state) {
    const from = stream.pos;
    const style = stex.token(stream, state);
    const token = stream.string.slice(from, stream.pos);
    return bracketCharacters.has(token) ? "bracket" : style;
  }
};

export const latexLanguage = StreamLanguage.define(latexStream);

interface BibtexState {
  quoted: boolean;
}

/** A small BibTeX mode for entry types, fields, values, comments and delimiters. */
const bibtexStream: StreamParser<BibtexState> = {
  startState: () => ({ quoted: false }),
  token(stream, state) {
    if (state.quoted) {
      let escaped = false;
      while (!stream.eol()) {
        const character = stream.next();
        if (character === '"' && !escaped) {
          state.quoted = false;
          break;
        }
        if (character === "\\" && !escaped) escaped = true;
        else escaped = false;
      }
      return "string";
    }
    if (stream.eatSpace()) return null;
    if (stream.peek() === "%") {
      stream.skipToEnd();
      return "comment";
    }
    if (stream.match(/^@[A-Za-z][A-Za-z0-9_-]*/)) return "keyword";
    if (stream.match(/^[A-Za-z][A-Za-z0-9_-]*(?=\s*=)/)) return "propertyName";
    if (stream.match(/^\\[A-Za-z@][A-Za-z@0-9:_-]*/)) return "meta";
    if (stream.match(/^\d+(?:\.\d+)?/)) return "number";
    const character = stream.next();
    if (character === '"') {
      state.quoted = true;
      return "string";
    }
    if (character === "{" || character === "}" || character === "(" || character === ")") return "bracket";
    if (character === "=" || character === "#") return "operator";
    if (character === ",") return "separator";
    stream.eatWhile(/[A-Za-z0-9_.:/+*?!-]/);
    return "string";
  }
};

export const bibtexLanguage = StreamLanguage.define(bibtexStream);
