import { StateEffect, StateField, type EditorState, type Range } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";
import type { AgentChange } from "../../shared/agentProtocol";

/** Unreviewed agent changes for the editor's document, and the one shown in the agent panel. */
export interface AgentChangeMarksInput {
  changes: readonly AgentChange[];
  activeId: string | null;
  /** Open a change in the agent panel's review; without it no button is shown. */
  open?: { label: string; onOpen: (id: string) => void };
}

export const setAgentChangeMarks = StateEffect.define<AgentChangeMarksInput | null>();

const insertedMark = Decoration.mark({ class: "cm-agent-change" });
const activeInsertedMark = Decoration.mark({ class: "cm-agent-change cm-agent-change-active" });

/** A thin marker where an agent deleted text, which leaves nothing to colour. */
class DeletionMarker extends WidgetType {
  constructor(private readonly active: boolean) { super(); }
  eq(other: DeletionMarker): boolean { return other.active === this.active; }
  toDOM(): HTMLElement {
    const marker = document.createElement("span");
    marker.className = `cm-agent-deletion${this.active ? " cm-agent-change-active" : ""}`;
    marker.setAttribute("aria-hidden", "true");
    return marker;
  }
}

const SVG = "http://www.w3.org/2000/svg";

/** Lucide's "bot" icon, drawn without React inside an editor widget. */
function botIcon(): SVGSVGElement {
  const svg = document.createElementNS(SVG, "svg");
  for (const [name, value] of Object.entries({ viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "2",
    "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" })) svg.setAttribute(name, value);
  const rect = document.createElementNS(SVG, "rect");
  for (const [name, value] of Object.entries({ width: "16", height: "12", x: "4", y: "8", rx: "2" })) rect.setAttribute(name, value);
  const path = document.createElementNS(SVG, "path");
  path.setAttribute("d", "M12 8V4H8 M2 14h2 M20 14h2 M15 13v2 M9 13v2");
  svg.append(rect, path);
  return svg;
}

/** A small button after an agent change that opens it in the agent panel's review. */
class ReviewButton extends WidgetType {
  constructor(private readonly id: string, private readonly active: boolean, private readonly open: NonNullable<AgentChangeMarksInput["open"]>) { super(); }
  eq(other: ReviewButton): boolean { return other.id === this.id && other.active === this.active && other.open.label === this.open.label; }
  toDOM(): HTMLElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `cm-agent-review-button${this.active ? " cm-agent-change-active" : ""}`;
    button.dataset.agentChangeId = this.id;
    button.title = this.open.label;
    button.setAttribute("aria-label", this.open.label);
    button.append(botIcon());
    // CodeMirror ignores widget events; handle them here so clicking never
    // moves the cursor and Enter/Space activate the button natively.
    button.addEventListener("mousedown", (event) => { event.preventDefault(); event.stopPropagation(); });
    button.addEventListener("keydown", (event) => event.stopPropagation());
    button.addEventListener("click", (event) => { event.stopPropagation(); this.open.onOpen(this.id); });
    return button;
  }
  ignoreEvent(): boolean { return true; }
}

function build(input: AgentChangeMarksInput | null, state: EditorState): DecorationSet {
  if (!input) return Decoration.none;
  const length = state.doc.length;
  const ranges: Range<Decoration>[] = [];
  for (const change of input.changes) {
    const active = change.id === input.activeId;
    for (const piece of change.pieces) {
      if (piece.from >= 0 && piece.to <= length && piece.from < piece.to) {
        ranges.push((active ? activeInsertedMark : insertedMark).range(piece.from, piece.to));
      }
    }
    for (const anchor of change.anchors) {
      if (anchor >= 0 && anchor <= length) ranges.push(Decoration.widget({ widget: new DeletionMarker(active), side: -1 }).range(anchor));
    }
    if (input.open && change.to >= 0 && change.to <= length) {
      ranges.push(Decoration.widget({ widget: new ReviewButton(change.id, active, input.open), side: 1 }).range(change.to));
    }
  }
  return Decoration.set(ranges, true);
}

/**
 * Background marks for agent-written text. They follow later edits through
 * CodeMirror's position mapping until the next server result replaces them,
 * so typing nearby never shifts them onto the wrong text.
 */
export const agentChangeMarks = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, transaction) {
    let mapped = value.map(transaction.changes);
    for (const effect of transaction.effects) {
      if (effect.is(setAgentChangeMarks)) mapped = build(effect.value, transaction.state);
    }
    return mapped;
  },
  provide: (field) => EditorView.decorations.from(field)
});
