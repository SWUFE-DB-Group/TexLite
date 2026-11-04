// @vitest-environment happy-dom
import { EditorState, type TransactionSpec } from "@codemirror/state";
import { type EditorView, type ViewUpdate } from "@codemirror/view";
import { SearchQuery, closeSearchPanel, openSearchPanel, search, setSearchQuery } from "@codemirror/search";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SearchOverview } from "../src/client/editorSearchOverview";

afterEach(() => { document.body.replaceChildren(); });

interface PendingMeasure {
  key?: unknown;
  read: (view: EditorView) => unknown;
  write?: (layout: unknown, view: EditorView) => void;
}

function fixture(source: string) {
  let state = EditorState.create({ doc: source, extensions: [search()] });
  const dom = document.createElement("div"), scrollDOM = document.createElement("div");
  dom.append(scrollDOM); document.body.append(dom);
  const requests = new Map<unknown, PendingMeasure>();
  let height = 200;
  Object.defineProperties(scrollDOM, {
    clientHeight: { get: () => height }, clientWidth: { get: () => 480 },
    scrollHeight: { get: () => state.doc.lines * 20 }
  });
  dom.getBoundingClientRect = () => ({ top: 10, right: 510 } as DOMRect);
  scrollDOM.getBoundingClientRect = () => ({ top: 60, right: 510, width: 500 } as DOMRect);
  const lineBlockAt = vi.fn((from: number) => ({ top: (state.doc.lineAt(from).number - 1) * 20 }));
  let overview: SearchOverview;
  const view = {
    dom, scrollDOM, documentPadding: { top: 0 }, lineBlockAt, plugin: () => null,
    get state() { return state; },
    requestMeasure(request: PendingMeasure) { requests.set(request.key, request); },
    dispatch(spec: TransactionSpec) {
      const startState = state, transaction = state.update(spec); state = transaction.state;
      overview.update({ state, startState, docChanged: transaction.docChanged, selectionSet: transaction.selection !== undefined, geometryChanged: transaction.docChanged } as ViewUpdate);
    }
  } as unknown as EditorView;
  overview = new SearchOverview(view);
  const measure = () => { const pending = [...requests.values()]; requests.clear(); pending.forEach(request => request.write?.(request.read(view), view)); };
  return { view, overview, lineBlockAt, measure,
    resize(value: number) { height = value; overview.update({ geometryChanged: true } as ViewUpdate); measure(); },
    positions: () => [...overview.dom.children].map(marker => Number.parseFloat((marker as HTMLElement).style.top)) };
}

describe("search match overview", () => {
  it("marks off-screen hits across the whole document and tracks query options, edits and panel closure", () => {
    const lines = Array.from({ length: 100 }, (_, i) => [0, 49, 99].includes(i) ? "model Model" : "prose");
    const h = fixture(lines.join("\n"));
    openSearchPanel(h.view);
    h.view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: "model", caseSensitive: true })) });
    h.measure();
    expect(h.positions()).toEqual([0, 98, 198]);
    expect(h.overview.dom.style.top).toBe("50px");
    expect(h.overview.dom.style.right).toBe("20px");
    h.view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: "MODEL", caseSensitive: true })) });
    h.measure(); expect(h.overview.dom.hidden).toBe(true);
    h.view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: "model", wholeWord: true })) });
    h.view.dispatch({ changes: { from: 0, to: 11, insert: "models" } });
    h.measure(); expect(h.positions()).toEqual([98, 198]);
    closeSearchPanel(h.view); h.measure();
    expect(h.overview.dom.hidden).toBe(true);
    expect(h.positions()).toEqual([]);
    h.overview.destroy();
  });

  it("coalesces dense hits, reuses matches during selection changes, and realigns after resize", () => {
    const h = fixture("x x x\n".repeat(10_000));
    openSearchPanel(h.view);
    h.view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: "x" })) });
    h.measure(); expect(h.positions().length).toBeLessThanOrEqual(100);
    h.lineBlockAt.mockClear();
    h.view.dispatch({ selection: { anchor: 0, head: 1 } });
    h.measure(); expect(h.lineBlockAt).not.toHaveBeenCalled();
    h.resize(100);
    expect(h.positions().length).toBeLessThanOrEqual(50);
    expect(Math.max(...h.positions())).toBeLessThanOrEqual(98);
    h.overview.destroy();
  });

  it("clears invalid regex results and does not publish a queued measurement after destruction", () => {
    const h = fixture("model\nmodel");
    openSearchPanel(h.view);
    h.view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: "model" })) });
    h.measure(); expect(h.overview.dom.hidden).toBe(false);
    h.view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: "[", regexp: true })) });
    h.measure(); expect(h.overview.dom.hidden).toBe(true);
    h.view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: "model" })) });
    h.overview.destroy(); h.measure();
    expect(h.overview.dom.isConnected).toBe(false);
    expect(h.positions()).toEqual([]);
  });
});
