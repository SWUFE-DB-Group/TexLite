import { StateEffect, StateField } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";
import type { Comment } from "./types";

type CommentMark = Pick<Comment, "id" | "resolved" | "orphaned"> & { from: number; to: number };
export const setSourceComments = StateEffect.define<CommentMark[]>();

export function sourceCommentMarksForFile(comments: readonly Comment[], filePath: string): CommentMark[] {
  return comments.filter((comment) => comment.filePath === filePath).map((comment) => ({
    id: comment.id, from: comment.startOffset, to: comment.endOffset,
    resolved: comment.resolved, orphaned: comment.orphaned
  }));
}

interface SourceCommentOptions {
  label: string;
  onOpen: (id: string) => void;
}

/** Leave ordinary caret placement and drag selection to CodeMirror. */
export function openSourceCommentOnClick(event: MouseEvent, view: EditorView, onOpen: SourceCommentOptions["onOpen"]): boolean {
  if (event.button !== 0 || event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey
    || !view.state.selection.main.empty) return false;
  const target = event.target;
  if (!(target instanceof Element)) return false;
  const id = target.closest<HTMLElement>("[data-source-comment-id]")?.dataset.sourceCommentId;
  if (id) onOpen(id);
  return false;
}

class CommentPin extends WidgetType {
  constructor(private readonly id: string, private readonly options: SourceCommentOptions) { super(); }

  toDOM(): HTMLElement {
    const pin = document.createElement("button");
    pin.type = "button";
    pin.className = "cm-comment-pin";
    pin.dataset.sourceCommentId = this.id;
    pin.title = this.options.label;
    pin.setAttribute("aria-label", this.options.label);
    pin.textContent = "●";
    // Widget events are ignored by CodeMirror. Handle activation here so
    // mouse, touch, and native Enter/Space all work without selecting source.
    pin.addEventListener("mousedown", (event) => { event.preventDefault(); event.stopPropagation(); });
    pin.addEventListener("keydown", (event) => event.stopPropagation());
    pin.addEventListener("click", (event) => { event.stopPropagation(); this.options.onOpen(this.id); });
    return pin;
  }
}

function buildCommentDecorations(marks: CommentMark[], documentLength: number, options: SourceCommentOptions): DecorationSet {
  // Finished or detached discussions leave the source entirely unmarked.
  const ranges = marks.filter((mark) => !mark.orphaned && !mark.resolved).flatMap((mark) => {
    const from = Math.max(0, Math.min(documentLength, mark.from));
    const to = Math.max(from, Math.min(documentLength, mark.to));
    const pin = Decoration.widget({ widget: new CommentPin(mark.id, options), side: 1 }).range(to);
    return from === to ? [pin] : [
      Decoration.mark({ class: "cm-source-comment", attributes: { "data-source-comment-id": mark.id } }).range(from, to), pin
    ];
  });
  return Decoration.set(ranges, true);
}

export function sourceCommentDecorations(options: SourceCommentOptions) {
  const marks = StateField.define<DecorationSet>({
    create: () => Decoration.none,
    update(value, transaction) {
      let mapped = value.map(transaction.changes);
      for (const effect of transaction.effects) {
        if (effect.is(setSourceComments)) mapped = buildCommentDecorations(effect.value, transaction.state.doc.length, options);
      }
      return mapped;
    },
    provide: (field) => EditorView.decorations.from(field)
  });
  return [marks, EditorView.domEventHandlers({
    click: (event, view) => openSourceCommentOnClick(event, view, options.onOpen)
  })];
}
