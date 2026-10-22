// @vitest-environment happy-dom
import { EditorState } from "@codemirror/state";
import { lineNumberMarkers, type EditorView } from "@codemirror/view";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GlobalTooltip } from "../src/client/GlobalTooltip";
import { selectionLineActions } from "../src/client/selectionLineActions";

let host: HTMLDivElement;
let workspace: HTMLDivElement;
let root: Root;

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  workspace = document.createElement("div");
  workspace.dataset.texliteTooltips = "off";
  document.body.append(host, workspace);
  root = createRoot(host);
  await act(async () => root.render(createElement(GlobalTooltip)));
  const state = EditorState.create({
    doc: "Selected source", selection: { anchor: 0, head: 8 },
    extensions: selectionLineActions({
      commentLabel: "Add comment", historyLabel: "Selection history", onComment: vi.fn(), onHistory: vi.fn()
    })
  });
  const marker = state.facet(lineNumberMarkers)[0]!.iter().value!;
  workspace.append(marker.toDOM!({ state } as EditorView));
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  workspace.remove();
  vi.unstubAllGlobals();
});

describe("selection action tooltips", () => {
  it.each([
    ["comment", "Add comment", "pointerover"], ["history", "Selection history", "pointerover"],
    ["comment", "Add comment", "focusin"], ["history", "Selection history", "focusin"]
  ])("updates the %s tooltip on %s (%s) without recreating the selection", async (action, label, eventName) => {
    const button = workspace.querySelector<HTMLButtonElement>(`.cm-selection-${action}`)!;
    await act(async () => button.dispatchEvent(eventName === "focusin"
      ? new FocusEvent(eventName, { bubbles: true })
      : new MouseEvent(eventName, { bubbles: true })));
    expect(host.querySelector('[role="tooltip"]')).toBeNull();
    expect(button.hasAttribute("title")).toBe(false); // No native tooltip while disabled, either.
    expect(button.getAttribute("aria-label")).toBe(label);

    for (const enabled of [true, false, true]) {
      await act(async () => {
        workspace.dataset.texliteTooltips = enabled ? "on" : "off";
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(host.querySelector('[role="tooltip"]')?.textContent ?? null).toBe(enabled ? label : null);
      expect(button.hasAttribute("title")).toBe(false);
      expect(workspace.querySelector(`.cm-selection-${action}`)).toBe(button);
    }
  });
});
