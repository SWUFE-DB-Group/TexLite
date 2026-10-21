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
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { toml } from "@codemirror/legacy-modes/mode/toml";
import { perl } from "@codemirror/legacy-modes/mode/perl";
import { properties } from "@codemirror/legacy-modes/mode/properties";
import { dockerFile } from "@codemirror/legacy-modes/mode/dockerfile";
import { cmake } from "@codemirror/legacy-modes/mode/cmake";
import type { TextLanguageKind } from "./textLanguages";

const shellLanguage = StreamLanguage.define(shell);
const tomlLanguage = StreamLanguage.define(toml);
const perlLanguage = StreamLanguage.define(perl);
const iniLanguage = StreamLanguage.define(properties);
const dockerLanguage = StreamLanguage.define(dockerFile);
const cmakeLanguage = StreamLanguage.define(cmake);

/** Loaded together only when a recognized auxiliary text language is opened. */
const languages: Record<TextLanguageKind, () => Extension> = {
  json, yaml, javascript, html, css, xml, python, markdown,
  jsx: () => javascript({ jsx: true }),
  typescript: () => javascript({ typescript: true }),
  tsx: () => javascript({ typescript: true, jsx: true }),
  shell: () => shellLanguage,
  toml: () => tomlLanguage,
  perl: () => perlLanguage,
  ini: () => iniLanguage,
  docker: () => dockerLanguage,
  cmake: () => cmakeLanguage
};

export function textLanguageSupport(kind: TextLanguageKind): Extension {
  return languages[kind]();
}
