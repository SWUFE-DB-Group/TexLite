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

const shellLanguage = StreamLanguage.define(shell);
const tomlLanguage = StreamLanguage.define(toml);
const perlLanguage = StreamLanguage.define(perl);
const iniLanguage = StreamLanguage.define(properties);
const dockerLanguage = StreamLanguage.define(dockerFile);
const cmakeLanguage = StreamLanguage.define(cmake);

export function isLatexEditorFile(filePath: string): boolean {
  return /\.(?:tex|sty|cls|ltx|dtx|ins|def)$/i.test(filePath);
}

/** Generic files must not inherit LaTeX parsing, auto-pairs or completions.
 * Unknown text stays plain text rather than guessing at its syntax.
 */
export function textFileLanguage(filePath: string, firstLine = ""): Extension {
  const name = filePath.split("/").at(-1)?.toLowerCase() ?? "";
  const extension = name.split(".").at(-1) ?? "";
  if (extension === "json" || extension === "jsonl" || extension === "ipynb") return json();
  if (extension === "yaml" || extension === "yml") return yaml();
  if (/^(?:[cm]?js|jsx|[cm]?ts|tsx)$/.test(extension)) {
    return javascript({ typescript: /^(?:[cm]?ts|tsx)$/.test(extension), jsx: extension === "jsx" || extension === "tsx" });
  }
  if (/^(?:html?|xhtml)$/.test(extension)) return html();
  if (extension === "css") return css();
  if (/^(?:xml|xsl|xslt|xsd)$/.test(extension)) return xml();
  if (/^(?:md|markdown|mdown)$/.test(extension) || name === "readme") return markdown();
  if (extension === "toml" || name === "cargo.lock") return tomlLanguage;
  if (extension === "pl" || extension === "pm" || /^\.?latexmkrc$/.test(name)) return perlLanguage;
  if (name === "dockerfile" || name.startsWith("dockerfile.")) return dockerLanguage;
  if (extension === "cmake" || name === "cmakelists.txt") return cmakeLanguage;
  if (/^(?:ini|properties|cfg)$/.test(extension) || name === ".env" || name.startsWith(".env.")) return iniLanguage;
  if (/^(?:sh|bash|zsh|ksh|bashrc|zshrc|profile)$/.test(extension)
    || /^(?:\.bashrc|\.zshrc|\.profile|\.bash_profile|pkgbuild)$/.test(name)
    || /^#!.*\b(?:bash|sh|zsh|ksh)\b/.test(firstLine)) return shellLanguage;
  if (extension === "py" || extension === "pyw" || /^#!.*\bpython[\d.]*\b/.test(firstLine)) return python();
  return [];
}
