import { defaultHighlightStyle, HighlightStyle, syntaxTree } from "@codemirror/language";
import type { EditorState, Range } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { highlightTree, tagHighlighter, tags } from "@lezer/highlight";
import type { EditorTheme } from "./editorThemes";
import { latexHighlightTags } from "./latex/highlighting";

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

const selectionHighlighter = tagHighlighter([
  { tag: tags.comment, class: "comment" },
  { tag: latexHighlightTags.referenceKey, class: "reference" }
]);
const selectedComment = Decoration.mark({ class: "cm-selected-comment" });
const selectedReference = Decoration.mark({ class: "cm-selected-reference" });

/** Reuse syntax tags to keep selected comments and reference keys readable. */
export function selectedSyntaxDecorations(state: EditorState, visibleRanges: readonly { from: number; to: number }[]): DecorationSet {
  const dark = state.facet(EditorView.darkTheme);
  const tree = syntaxTree(state);
  const marks: Range<Decoration>[] = [];
  for (const selection of state.selection.ranges) {
    if (selection.empty) continue;
    for (const visible of visibleRanges) {
      const from = Math.max(selection.from, visible.from), to = Math.min(selection.to, visible.to);
      if (from >= to) continue;
      highlightTree(tree, selectionHighlighter, (start, end, classes) => {
        if (classes === "reference") marks.push(selectedReference.range(start, end));
        else if (dark) marks.push(selectedComment.range(start, end));
      }, from, to);
    }
  }
  return Decoration.set(marks, true);
}

export const selectedSyntaxHighlighting = ViewPlugin.fromClass(class {
  decorations: DecorationSet;
  constructor(view: EditorView) {
    this.decorations = selectedSyntaxDecorations(view.state, view.visibleRanges);
  }
  update(update: ViewUpdate) {
    if (update.docChanged || update.selectionSet || update.viewportChanged
      || syntaxTree(update.startState) !== syntaxTree(update.state)
      || update.startState.facet(EditorView.darkTheme) !== update.state.facet(EditorView.darkTheme)) {
      this.decorations = selectedSyntaxDecorations(update.state, update.view.visibleRanges);
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
