import { StreamLanguage, type StreamParser } from "@codemirror/language";
import { linter } from "@codemirror/lint";
import { stex } from "@codemirror/legacy-modes/mode/stex";
import { tags, styleTags } from "@lezer/highlight";
import {
  bibtexBracketMatching,
  bibtexCompletionSource,
  bibtexLanguage as baseBibtexLanguage,
  bibtexLinter
} from "codemirror-lang-bib";

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
