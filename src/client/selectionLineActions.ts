import { RangeSet, StateField, type EditorState } from "@codemirror/state";
import { GutterMarker, lineNumberMarkers, lineNumbers, type EditorView } from "@codemirror/view";

export type SelectionLineAction = (text: string, from: number, to: number, source: string) => void;

interface SelectionActions {
  commentLabel: string;
  historyLabel: string;
  onComment: SelectionLineAction;
  onHistory: SelectionLineAction;
}

/** Replace the selection's first line number with two contextual actions. */
class SelectionActionsMarker extends GutterMarker {
  constructor(private readonly actions: SelectionActions) { super(); }

  toDOM(view: EditorView): HTMLElement {
    const group = document.createElement("span");
    group.className = "cm-selection-line-actions";
    const definitions = [
      { name: "comment", label: this.actions.commentLabel, callback: this.actions.onComment,
        path: "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z M12 7v6 M9 10h6" },
      { name: "history", label: this.actions.historyLabel, callback: this.actions.onHistory,
        path: "M3 11a9 9 0 1 1 2.4 7 M3 4v7h7 M12 7v5l3 2" }
    ];
    for (const action of definitions) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `cm-selection-action-button cm-selection-${action.name}`;
      button.dataset.texliteTooltipAlways = "true";
      button.title = action.label;
      button.setAttribute("aria-label", action.label);
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("viewBox", "0 0 24 24");
      svg.setAttribute("aria-hidden", "true");
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", action.path);
      svg.append(path);
      button.append(svg);
      // Keep both CodeMirror's selection and React's dialog input intact.
      // Use click for activation so keyboard and touch work as well as mouse.
      button.addEventListener("mousedown", (event) => {
        event.preventDefault();
        event.stopPropagation();
      });
      button.addEventListener("keydown", (event) => event.stopPropagation());
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        const selection = view.state.selection.main;
        if (selection.empty) return;
        action.callback(view.state.sliceDoc(selection.from, selection.to), selection.from, selection.to, view.state.doc.toString());
      });
      group.append(button);
    }
    return group;
  }
}

function selectionMarkers(state: EditorState, marker: GutterMarker): RangeSet<GutterMarker> {
  const selection = state.selection.main;
  return selection.empty ? RangeSet.empty : RangeSet.of([marker.range(state.doc.lineAt(selection.from).from)]);
}

export function selectionLineActions(actions: SelectionActions) {
  const marker = new SelectionActionsMarker(actions);
  const field = StateField.define<RangeSet<GutterMarker>>({
    create: (state) => selectionMarkers(state, marker),
    update: (value, transaction) => transaction.selection || transaction.docChanged
      ? selectionMarkers(transaction.state, marker)
      : value,
    provide: (field) => lineNumberMarkers.from(field)
  });
  return [field, lineNumbers()];
}
