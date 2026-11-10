import { StateEffect, StateField, type EditorState, type Range, type Transaction } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";
import type { AgentChange } from "../../shared/agentProtocol";

/** Unreviewed agent changes for the editor's document, and the one shown in the agent panel. */
export interface AgentChangeMarksInput {
  changes: readonly AgentChange[];
  activeId: string | null;
  /** Open a change in the agent panel's review; without it no button is shown. */
  open?: { label: string; onOpen: (id: string) => void };
  /**
   * The document has moved on from the revision these changes were computed
   * for. Keep the marks where editing carried them and only apply which
   * changes remain and which is active.
   */
  restyleOnly?: boolean;
}

export const setAgentChangeMarks = StateEffect.define<AgentChangeMarksInput | null>();

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

type MarkKind = "inserted" | "deletion" | "button";

/** One mark of a change; its spec names the change so the mark can be found and restyled. */
function decoration(kind: MarkKind, changeId: string, input: AgentChangeMarksInput): Decoration | null {
  const active = changeId === input.activeId;
  const spec = { changeId, kind };
  if (kind === "inserted") return Decoration.mark({ ...spec, class: `cm-agent-change${active ? " cm-agent-change-active" : ""}` });
  if (kind === "deletion") return Decoration.widget({ ...spec, widget: new DeletionMarker(active), side: -1 });
  return input.open ? Decoration.widget({ ...spec, widget: new ReviewButton(changeId, active, input.open), side: 1 }) : null;
}

function build(input: AgentChangeMarksInput | null, state: EditorState): DecorationSet {
  if (!input) return Decoration.none;
  const length = state.doc.length;
  const ranges: Range<Decoration>[] = [];
  const add = (kind: MarkKind, id: string, from: number, to = from) => {
    const mark = decoration(kind, id, input);
    if (mark && from >= 0 && to <= length) ranges.push(mark.range(from, to));
  };
  for (const change of input.changes) {
    for (const piece of change.pieces) if (piece.from < piece.to) add("inserted", change.id, piece.from, piece.to);
    for (const anchor of change.anchors) add("deletion", change.id, anchor);
    add("button", change.id, change.to);
  }
  return Decoration.set(ranges, true);
}

function restyle(marks: DecorationSet, input: AgentChangeMarksInput, state: EditorState): DecorationSet {
  const remaining = new Set(input.changes.map((change) => change.id));
  const ranges: Range<Decoration>[] = [];
  marks.between(0, state.doc.length, (from, to, value) => {
    const { changeId, kind } = value.spec as { changeId: string; kind: MarkKind };
    const mark = remaining.has(changeId) ? decoration(kind, changeId, input) : null;
    if (mark) ranges.push(mark.range(from, to));
  });
  return Decoration.set(ranges, true);
}

/**
 * Text typed inside agent text is not the agent's. Mapping stretches a mark
 * over it, so cut it out until a server result replaces the marks.
 */
function excludeInsertions(marks: DecorationSet, transaction: Transaction): DecorationSet {
  const inserted: Array<[number, number]> = [];
  transaction.changes.iterChanges((_fromA, _toA, fromB, toB) => { if (toB > fromB) inserted.push([fromB, toB]); });
  const covered = (from: number, to: number) => inserted.some(([start, end]) => start < to && from < end);
  let affected = false;
  const ranges: Range<Decoration>[] = [];
  marks.between(0, transaction.newDoc.length, (from, to, value) => {
    if (from === to || !covered(from, to)) { ranges.push(value.range(from, to)); return; }
    affected = true;
    let cursor = from;
    for (const [start, end] of inserted) {
      if (end <= cursor || start >= to) continue;
      if (start > cursor) ranges.push(value.range(cursor, start));
      cursor = end;
    }
    if (cursor < to) ranges.push(value.range(cursor, to));
  });
  return affected ? Decoration.set(ranges, true) : marks;
}

/** Where a change's marks currently start, following any edits since they were placed. */
export function agentChangeStart(state: EditorState, id: string): number | null {
  let start: number | null = null;
  state.field(agentChangeMarks).between(0, state.doc.length, (from, _to, value) => {
    if ((value.spec as { changeId: string }).changeId !== id) return undefined;
    start = from;
    return false;
  });
  return start;
}

/**
 * Background marks for agent-written text. They follow later edits through
 * CodeMirror's position mapping until a server result for the current text
 * replaces them, so typing nearby never shifts them onto the wrong text.
 */
export const agentChangeMarks = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, transaction) {
    let mapped = value.map(transaction.changes);
    if (transaction.docChanged && mapped.size) mapped = excludeInsertions(mapped, transaction);
    for (const effect of transaction.effects) {
      if (effect.is(setAgentChangeMarks)) {
        mapped = effect.value?.restyleOnly ? restyle(mapped, effect.value, transaction.state) : build(effect.value, transaction.state);
      }
    }
    return mapped;
  },
  provide: (field) => EditorView.decorations.from(field)
});
