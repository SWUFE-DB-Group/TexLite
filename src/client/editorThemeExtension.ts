import { defaultHighlightStyle, HighlightStyle, syntaxTree } from "@codemirror/language";
import type { EditorState, Range } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { highlightTree, tagHighlighter, tags } from "@lezer/highlight";
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
  return token ? { ...spec, color: `var(--tl-code-${token})`, ...(token === "comment" ? { class: "cm-code-comment" } : {}) } : spec;
}));

const commentHighlighter = tagHighlighter([{ tag: tags.comment, class: "comment" }]);
const selectedComment = Decoration.mark({ class: "cm-selected-comment" });

/** Use each language's comment tags, including BibTeX and BST, without rescanning source text. */
export function selectedCommentDecorations(state: EditorState, visibleRanges: readonly { from: number; to: number }[]): DecorationSet {
  if (!state.facet(EditorView.darkTheme)) return Decoration.none;
  const tree = syntaxTree(state);
  const marks: Range<Decoration>[] = [];
  for (const selection of state.selection.ranges) {
    if (selection.empty) continue;
    for (const visible of visibleRanges) {
      const from = Math.max(selection.from, visible.from), to = Math.min(selection.to, visible.to);
      if (from >= to) continue;
      highlightTree(tree, commentHighlighter, (start, end) => {
        marks.push(selectedComment.range(start, end));
      }, from, to);
    }
  }
  return Decoration.set(marks, true);
}

export const selectedCommentHighlighting = ViewPlugin.fromClass(class {
  decorations: DecorationSet;
  constructor(view: EditorView) {
    this.decorations = selectedCommentDecorations(view.state, view.visibleRanges);
  }
  update(update: ViewUpdate) {
    if (update.docChanged || update.selectionSet || update.viewportChanged
      || syntaxTree(update.startState) !== syntaxTree(update.state)
      || update.startState.facet(EditorView.darkTheme) !== update.state.facet(EditorView.darkTheme)) {
      this.decorations = selectedCommentDecorations(update.state, update.view.visibleRanges);
    }
  }
}, { decorations: (plugin) => plugin.decorations });

const schemes = {
  light: EditorView.theme({}, { dark: false }),
  dark: EditorView.theme({}, { dark: true })
};

/** Reconfigured inside the existing appearance Compartment, preserving state. */
export function editorColorScheme(theme: EditorTheme) {
  return schemes[theme];
}
