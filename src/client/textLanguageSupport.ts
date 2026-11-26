import type { Extension } from "@codemirror/state";
import { StreamLanguage } from "@codemirror/language";
import { json } from "@codemirror/lang-json";
import { yaml } from "@codemirror/lang-yaml";
import { javascript } from "@codemirror/lang-javascript";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { xml } from "@codemirror/lang-xml";
import { python } from "@codemirror/lang-python";
import { markdown } from "@codemirror/lang-markdown";
import type { TextLanguageKind } from "./textLanguages";

// Highlight common latexmk settings, not arbitrary Perl.
const latexmkrc = StreamLanguage.define({
  startState: () => ({ quote: "" }),
  token(stream, state) {
    if (!state.quote) {
      if (stream.match(/^\$[A-Za-z_]\w*/)) return "variableName.definition";
      if (stream.eat("#")) { stream.skipToEnd(); return "lineComment"; }
      const quote = stream.eat(/['"]/);
      if (!quote) {
        stream.next();
        stream.eatWhile(/[^$#'"]/);
        return null;
      }
      state.quote = quote;
    }
    while (!stream.eol()) {
      const ch = stream.next();
      if (ch === "\\") stream.next();
      else if (ch === state.quote) { state.quote = ""; break; }
    }
    return "string";
  }
});

/** Loaded together only when a recognized auxiliary text language is opened. */
const languages: Record<TextLanguageKind, () => Extension> = {
  json, yaml, javascript, html, css, xml, python, markdown,
  jsx: () => javascript({ jsx: true }),
  typescript: () => javascript({ typescript: true }),
  tsx: () => javascript({ typescript: true, jsx: true }),
  latexmkrc: () => latexmkrc
};

export function textLanguageSupport(kind: TextLanguageKind): Extension {
  return languages[kind]();
}
