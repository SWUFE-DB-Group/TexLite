import { defaultHighlightStyle, HighlightStyle } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import type { EditorTheme } from "./editorThemes";

// Adapt CodeMirror's shipped generic highlighter rather than duplicating its
// tag precedence or changing the existing light BibTeX/BST appearance.
const genericColorTokens: Readonly<Record<string, string>> = {
  "#404740": "meta", "#708": "keyword", "#219": "atom", "#164": "literal", "#a11": "string",
  "#e40": "escape", "#00f": "definition", "#30a": "local", "#085": "type", "#167": "class",
  "#256": "macro", "#00c": "property", "#940": "comment", "#f00": "invalid"
};

export const editorGenericHighlightStyle = HighlightStyle.define(defaultHighlightStyle.specs.map((spec) => {
  const token = typeof spec.color === "string" ? genericColorTokens[spec.color.toLowerCase()] : undefined;
  return token ? { ...spec, color: `var(--tl-code-${token})` } : spec;
}));

const schemes = {
  light: EditorView.theme({}, { dark: false }),
  dark: EditorView.theme({}, { dark: true })
};

/** Reconfigured inside the existing appearance Compartment, preserving state. */
export function editorColorScheme(theme: EditorTheme) {
  return schemes[theme];
}
