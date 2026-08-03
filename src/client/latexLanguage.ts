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
