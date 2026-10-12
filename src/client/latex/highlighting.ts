import { HighlightStyle, syntaxTree } from "@codemirror/language";
import type { EditorState, Range } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import type { SyntaxNode, Tree } from "@lezer/common";
import { Tag, tags } from "@lezer/highlight";

// Parent tags preserve the language's semantics for other highlighters. These
// refinements distinguish environments from reference keys and raw text from math.
export const latexHighlightTags = {
  environment: Tag.define(tags.attributeValue),
  heading: Tag.define(tags.heading),
  mathDelimiter: Tag.define(tags.string),
  literal: Tag.define(tags.string)
};

export const latexHighlightStyle = HighlightStyle.define([
  { tag: tags.tagName, class: "cm-tl-command" },
  { tag: tags.keyword, class: "cm-tl-structure" },
  { tag: latexHighlightTags.environment, class: "cm-tl-environment" },
  { tag: latexHighlightTags.heading, class: "cm-tl-heading" },
  { tag: latexHighlightTags.mathDelimiter, class: "cm-tl-math-delimiter" },
  { tag: latexHighlightTags.literal, class: "cm-tl-literal" },
  { tag: tags.attributeValue, class: "cm-tl-key" },
  { tag: tags.escape, class: "cm-tl-special" },
  { tag: [tags.brace, tags.squareBracket], class: "cm-tl-bracket" },
  { tag: tags.comment, class: "cm-tl-comment" }
]);

const commandToken = /^(?:CtrlSeq|Csname)$|CtrlSeq$/;

function isMathCommand(node: SyntaxNode): boolean {
  for (let parent = node.parent; parent; parent = parent.parent) {
    // Commands in \text{...} retain ordinary prose-command colors.
    if (parent.name === "TextArgument") return false;
    if (parent.name === "Math") return true;
  }
  return false;
}

/** Visible tree ranges only; no independent TeX regex parser or forced parsing. */
export function latexSemanticDecorations(
  state: EditorState,
  visibleRanges: readonly { from: number; to: number }[],
  tree: Tree = syntaxTree(state)
): DecorationSet {
  const marks: Range<Decoration>[] = [];
  for (const visible of visibleRanges) {
    tree.iterate({ from: visible.from, to: visible.to, enter(ref) {
      if (ref.from === ref.to) return;
      const node = ref.node;
      const from = Math.max(ref.from, visible.from);
      const to = Math.min(ref.to, visible.to);
      if (from >= to) return;
      if (commandToken.test(ref.name) && isMathCommand(node)) {
        marks.push(Decoration.mark({ class: "cm-tl-math-command" }).range(from, to));
      }
      if (ref.name === "Comment") {
        // Read only the visible portion, with word boundaries preserved at its
        // edges. A long commented-out paragraph must not copy the entire line.
        const start = Math.max(ref.from, from - 1);
        const end = Math.min(ref.to, to + 1);
        const text = state.sliceDoc(start, end);
        for (const match of text.matchAll(/\b(?:TODO|FIXME)\b/g)) {
          const wordFrom = start + match.index;
          const wordTo = wordFrom + match[0].length;
          if (wordFrom >= from && wordTo <= to) {
            marks.push(Decoration.mark({ class: "cm-tl-comment-task" }).range(wordFrom, wordTo));
          }
        }
        return false;
      }
    } });
  }
  return Decoration.set(marks, true);
}

export const latexSemanticHighlighting = ViewPlugin.fromClass(class {
  decorations: DecorationSet;
  constructor(view: EditorView) {
    this.decorations = latexSemanticDecorations(view.state, view.visibleRanges);
  }
  update(update: ViewUpdate) {
    if (update.docChanged || update.viewportChanged || syntaxTree(update.startState) !== syntaxTree(update.state)) {
      this.decorations = latexSemanticDecorations(update.state, update.view.visibleRanges);
    }
  }
}, { decorations: (plugin) => plugin.decorations });
