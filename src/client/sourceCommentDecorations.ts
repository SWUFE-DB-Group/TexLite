import { Facet, StateEffect, StateField, type EditorState } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import type { Comment } from "./types";
import { mapSourceAnchor, sourceAnchorAt, type AnchorChange, type SourceAnchor } from "../shared/sourceCommentAnchors";
import { sourceHash } from "./sourceHash";

type CommentMark = Pick<Comment, "id" | "resolved" | "orphaned" | "selectedText" | "contextBefore" | "contextAfter" | "anchorSourceHash"> & { from: number; to: number };
type AnchoredComment = Pick<Comment, "id" | "resolved"> & SourceAnchor & { serverMark: CommentMark; revisionPending?: boolean };
const commentAnchors = Facet.define<readonly AnchoredComment[], readonly AnchoredComment[]>({ combine: (values) => values.flat() });
export const setSourceComments = StateEffect.define<CommentMark[]>();

export function sourceCommentMarksForFile(comments: readonly Comment[], filePath: string): CommentMark[] {
  return comments.filter((comment) => comment.filePath === filePath).map((comment) => ({
    id: comment.id, from: comment.startOffset, to: comment.endOffset,
    resolved: comment.resolved, orphaned: comment.orphaned, selectedText: comment.selectedText,
    contextBefore: comment.contextBefore, contextAfter: comment.contextAfter, anchorSourceHash: comment.anchorSourceHash
  }));
}

/** Source navigation uses the live range, not offsets from the last saved revision. */
export function sourceCommentAnchorForId(state: EditorState, id: string): SourceAnchor | undefined {
  return state.facet(commentAnchors).find((comment) => comment.id === id);
}

interface SourceCommentOptions {
  label: string;
  onOpen: (id: string, toggle?: boolean) => void;
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
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "1.8");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z M8 8h8 M8 12h5");
    svg.append(path);
    pin.append(svg);
    // Widget events are ignored by CodeMirror. Handle activation here so
    // mouse, touch, and native Enter/Space all work without selecting source.
    pin.addEventListener("mousedown", (event) => { event.preventDefault(); event.stopPropagation(); });
    pin.addEventListener("keydown", (event) => event.stopPropagation());
    pin.addEventListener("click", (event) => { event.stopPropagation(); this.options.onOpen(this.id, true); });
    return pin;
  }
}

function buildCommentDecorations(marks: readonly AnchoredComment[], documentLength: number, options: SourceCommentOptions): DecorationSet {
  // Finished or detached discussions leave the source entirely unmarked.
  const ranges = marks.filter((mark) => !mark.orphaned && !mark.resolved).flatMap((mark) => {
    const from = Math.max(0, Math.min(documentLength, mark.startOffset));
    const to = Math.max(from, Math.min(documentLength, mark.endOffset));
    const pin = Decoration.widget({ widget: new CommentPin(mark.id, options), side: 1 }).range(to);
    return from === to ? [pin] : [
      Decoration.mark({ class: "cm-source-comment", attributes: { "data-source-comment-id": mark.id } }).range(from, to), pin
    ];
  });
  return Decoration.set(ranges, true);
}

export function sourceCommentDecorations(options: SourceCommentOptions) {
  const checkedRevision = StateEffect.define<{ doc: EditorState["doc"]; hash: string }>();
  const marks = StateField.define<{ anchors: readonly AnchoredComment[]; decorations: DecorationSet }>({
    create: () => ({ anchors: [], decorations: Decoration.none }),
    update(value, transaction) {
      if (!transaction.docChanged && !transaction.effects.some((effect) => effect.is(setSourceComments) || effect.is(checkedRevision))) return value;
      let anchors = value.anchors;
      let currentHash: string | undefined;
      const matchesRevision = (mark: CommentMark) => mark.anchorSourceHash !== undefined
        && mark.anchorSourceHash === (currentHash ??= sourceHash(transaction.state.doc.toString()));
      const fromServer = (mark: CommentMark, unverified = false): AnchoredComment => {
        const fallback = sourceAnchorAt(transaction.state.doc, mark.from, mark.to);
        const anchor: SourceAnchor = {
          startOffset: mark.from, endOffset: mark.to, selectedText: mark.selectedText,
          contextBefore: mark.contextBefore ?? fallback.contextBefore,
          contextAfter: mark.contextAfter ?? fallback.contextAfter, orphaned: mark.orphaned
        };
        return { id: mark.id, resolved: mark.resolved, serverMark: mark,
          ...(unverified ? { ...anchor, orphaned: true } : mapSourceAnchor(anchor, transaction.state.doc, transaction.state.doc, [], 512))
        };
      };
      if (transaction.docChanged && anchors.length) {
        const changes: AnchorChange[] = [];
        transaction.changes.iterChangedRanges((from, to, fromB, toB) => {
          changes.push({ from, to, insertLength: toB - fromB });
        });
        anchors = anchors.map((comment) => ({ ...comment,
          ...mapSourceAnchor(comment, transaction.startState.doc, transaction.state.doc, changes, 512)
        }));
      }
      for (const effect of transaction.effects) {
        if (effect.is(checkedRevision)) {
          if (effect.value.doc === transaction.state.doc) {
            anchors = anchors.map((comment) => comment.revisionPending && comment.serverMark.anchorSourceHash === effect.value.hash
              ? fromServer(comment.serverMark) : comment);
          }
          continue;
        }
        if (!effect.is(setSourceComments)) continue;
        const current = new Map(anchors.map((comment) => [comment.id, comment]));
        anchors = effect.value.map((mark) => {
          const existing = current.get(mark.id);
          const previous = existing?.serverMark;
          // The server can reject an inferred external mapping which looked
          // like real edits locally. Only override live/undo state when the
          // response belongs to this exact source revision.
          if (matchesRevision(mark)) return fromServer(mark);
          if (mark.anchorSourceHash !== undefined) {
            // A mismatched revision is not evidence about the current range,
            // even when a duplicate happens to occupy the saved offsets. Keep
            // the live quote/context (including detached state) until verified.
            return existing
              ? { ...existing, resolved: mark.resolved, serverMark: mark, revisionPending: true }
              : { ...fromServer(mark, true), revisionPending: true };
          }
          // Older responses cannot reactivate an erased selection either.
          if (existing?.orphaned && !mark.orphaned) return { ...existing, resolved: mark.resolved, serverMark: mark };
          // Replies/resolution notifications can return unchanged persisted
          // offsets while typing. Preserve the local mapping in that case.
          if (existing && previous && previous.from === mark.from && previous.to === mark.to
            && previous.selectedText === mark.selectedText && previous.orphaned === mark.orphaned
            && previous.contextBefore === mark.contextBefore && previous.contextAfter === mark.contextAfter) {
            return { ...existing, resolved: mark.resolved, serverMark: mark };
          }
          // A save response can be one or more edits behind the live Y.Text.
          // Keep a valid live anchor rather than replacing it with stale
          // offsets or a deletion state which has already been undone.
          const doc = transaction.state.doc;
          if (existing && !existing.orphaned
            && doc.sliceString(existing.startOffset, existing.endOffset) === existing.selectedText
            && (mark.orphaned || doc.sliceString(mark.from, mark.to) !== mark.selectedText)) {
            return { ...existing, resolved: mark.resolved, serverMark: mark };
          }
          return fromServer(mark);
        });
      }
      return { anchors, decorations: buildCommentDecorations(anchors, transaction.state.doc.length, options) };
    },
    provide: (field) => [EditorView.decorations.from(field, (value) => value.decorations), commentAnchors.from(field, (value) => value.anchors)]
  });
  const revisionChecks = ViewPlugin.fromClass(class {
    private timer: ReturnType<typeof setTimeout> | undefined;
    constructor(private readonly view: EditorView) { this.schedule(); }
    update(update: ViewUpdate) {
      if (update.docChanged || update.transactions.some((transaction) => transaction.effects.some((effect) => effect.is(setSourceComments)))) {
        this.schedule();
      }
    }
    private schedule() {
      clearTimeout(this.timer);
      this.timer = undefined;
      if (!this.view.state.field(marks).anchors.some((comment) => comment.revisionPending)) return;
      // An HTTP result can precede its Yjs source update. Recheck only pending
      // results after an editing pause, never hash from a docChanged transaction.
      this.timer = setTimeout(() => {
        this.timer = undefined;
        const doc = this.view.state.doc;
        const hash = sourceHash(doc.toString());
        this.view.dispatch({ effects: checkedRevision.of({ doc, hash }) });
      }, 200);
    }
    destroy() { clearTimeout(this.timer); }
  });
  return [marks, revisionChecks, EditorView.domEventHandlers({
    click: (event, view) => openSourceCommentOnClick(event, view, options.onOpen)
  })];
}
