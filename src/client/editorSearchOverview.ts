import { getSearchQuery, searchPanelOpen } from "@codemirror/search";
import { type EditorState } from "@codemirror/state";
import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { searchQuerySignature } from "./editorSearch";

/** Native scrollbars cannot host markers consistently across browsers. Keep a
 * decorative overview immediately beside the scrollbar, outside scrolled text. */
export class SearchOverview {
  readonly dom: HTMLDivElement;
  private lines: number[] = [];
  private signature = "";
  private document: EditorState["doc"] | null = null;
  private open = false;
  private destroyed = false;

  constructor(private readonly view: EditorView) {
    this.dom = view.dom.ownerDocument.createElement("div");
    this.dom.className = "cm-search-overview";
    this.dom.setAttribute("aria-hidden", "true");
    this.dom.hidden = true;
    view.dom.append(this.dom);
    this.refresh();
  }

  update(update: ViewUpdate): void {
    const changed = this.refresh();
    if (!changed && this.open && update.geometryChanged) this.measure();
  }

  destroy(): void { this.destroyed = true; this.dom.remove(); }

  private refresh(): boolean {
    const state = this.view.state;
    const open = searchPanelOpen(state);
    const query = getSearchQuery(state);
    const signature = searchQuerySignature(query);
    if (open === this.open && state.doc === this.document && signature === this.signature) return false;
    const wasOpen = this.open;
    this.open = open;
    this.document = state.doc;
    this.signature = signature;
    this.lines = [];
    if (open && query.valid && query.search) {
      const lines = new Set<number>();
      const cursor = query.getCursor(state);
      for (let next = cursor.next(); !next.done; next = cursor.next()) {
        lines.add(state.doc.lineAt(next.value.from).number);
      }
      this.lines = [...lines];
    }
    if (open || wasOpen) this.measure();
    return true;
  }

  private measure(): void {
    this.view.requestMeasure({
      key: this,
      read: () => {
        if (this.destroyed || !this.lines.length) return null;
        const scroller = this.view.scrollDOM;
        const height = scroller.clientHeight;
        if (!height || !scroller.scrollHeight) return null;
        const editor = this.view.dom.getBoundingClientRect();
        const rect = scroller.getBoundingClientRect();
        const positions = new Set<number>();
        for (const line of this.lines) {
          const y = this.view.lineBlockAt(this.view.state.doc.line(line).from).top + this.view.documentPadding.top;
          // Coalesce dense hits into two-pixel bins; DOM size is bounded by
          // viewport height, not the number of matches in the document.
          positions.add(Math.max(0, Math.min(height - 2, Math.floor(y / scroller.scrollHeight * height / 2) * 2)));
        }
        // Overlay scrollbars (Safari/touch devices) do not reduce clientWidth.
        const scrollbar = Math.max(6, rect.width - scroller.clientWidth);
        return { top: rect.top - editor.top, right: Math.max(0, editor.right - rect.right + scrollbar), height, positions };
      },
      write: (layout) => {
        if (this.destroyed) return;
        this.dom.hidden = !layout;
        if (!layout) { this.dom.replaceChildren(); return; }
        Object.assign(this.dom.style, { top: `${layout.top}px`, right: `${layout.right}px`, height: `${layout.height}px` });
        this.dom.replaceChildren(...[...layout.positions].map((top) => {
          const marker = this.dom.ownerDocument.createElement("span");
          marker.className = "cm-search-overview-mark";
          marker.style.top = `${top}px`;
          return marker;
        }));
      }
    });
  }
}

export const editorSearchOverview = ViewPlugin.fromClass(SearchOverview);
