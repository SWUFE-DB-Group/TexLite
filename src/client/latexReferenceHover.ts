import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";

const referenceSelector = "[data-latex-reference-kind][data-latex-reference-key]";
const activeClass = "cm-reference-navigation-active";

/** Highlight only the pointed-at key; keyboard modifiers may change in place. */
export const latexReferenceHover = ViewPlugin.fromClass(class {
  private hovered: HTMLElement | null = null;
  private active: HTMLElement | null = null;
  constructor(private view: EditorView) {
    document.addEventListener("keydown", this.modifiers);
    document.addEventListener("keyup", this.modifiers);
    window.addEventListener("blur", this.leave);
  }
  private modifiers = (event: KeyboardEvent) => {
    this.activate(event.ctrlKey || event.metaKey ? this.hovered : null);
  };
  private activate(target: HTMLElement | null) {
    if (target && (!target.isConnected || !this.view.dom.contains(target))) target = null;
    if (target === this.active) return;
    this.active?.classList.remove(activeClass);
    this.active = target;
    this.active?.classList.add(activeClass);
  }
  move(event: MouseEvent) {
    this.hovered = event.target instanceof Element ? event.target.closest<HTMLElement>(referenceSelector) : null;
    this.activate(event.ctrlKey || event.metaKey ? this.hovered : null);
    return false;
  }
  leave = () => {
    this.hovered = null;
    this.activate(null);
    return false;
  };
  update(update: ViewUpdate) {
    if (update.docChanged || update.viewportChanged) this.leave();
  }
  destroy() {
    this.leave();
    document.removeEventListener("keydown", this.modifiers);
    document.removeEventListener("keyup", this.modifiers);
    window.removeEventListener("blur", this.leave);
  }
}, { eventHandlers: {
  mousemove(event) { return this.move(event); },
  mouseleave() { return this.leave(); }
} });
