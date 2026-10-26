// @vitest-environment happy-dom
import { act, createElement, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorTerminalLayout } from "../src/client/workspace/EditorTerminalLayout";
import { AgentTerminal } from "../src/client/workspace/AgentTerminal";

const lifecycle = vi.hoisted(() => ({ editorMounts: 0, editorUnmounts: 0, terminalMounts: 0, terminalUnmounts: 0 }));
vi.mock("react-i18next", async (original) => ({ ...await original<typeof import("react-i18next")>(), useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("../src/client/agents/useAgentTasks", () => ({ useAgentTasks: () => ({
  catalog: { ptyAvailable: true, agents: [{ id: "codex", label: "Codex", installed: true, enabled: true }] },
  selected: { id: "task", agentId: "codex", title: "Task", state: "running", cleanupState: "none" },
  result: { tasks: [{ id: "task", agentId: "codex", title: "Task", state: "running" }], total: 1, activeTaskId: "task" },
  busy: false, error: "", page: 1, acceptTask: vi.fn()
}) }));
vi.mock("../src/client/agents/AgentTerminalSurface", async () => {
  const react = await import("react");
  return { AgentTerminalSurface: () => {
    react.useEffect(() => { lifecycle.terminalMounts++; return () => { lifecycle.terminalUnmounts++; }; }, []);
    return react.createElement("div", { "data-live-terminal": true }, "Preserved terminal output");
  } };
});

class LayoutObserver implements ResizeObserver {
  static instances = new Set<LayoutObserver>();
  targets = new Set<Element>();
  constructor(private callback: ResizeObserverCallback) { LayoutObserver.instances.add(this); }
  observe(target: Element) { this.targets.add(target); }
  unobserve(target: Element) { this.targets.delete(target); }
  disconnect() { this.targets.clear(); LayoutObserver.instances.delete(this); }
  flush() {
    const entries: ResizeObserverEntry[] = [...this.targets].map((target) => {
      const size = [{ inlineSize: 1200, blockSize: (target as HTMLElement).offsetHeight }];
      return { target, borderBoxSize: size, contentBoxSize: size, devicePixelContentBoxSize: size, contentRect: target.getBoundingClientRect() };
    });
    this.callback(entries, this);
  }
}

// Simulate browser flex measurements while exercising the real panel library.
function height(element: HTMLElement): number {
  if (!element.isConnected) return 0;
  if (element.hasAttribute("data-separator")) return 5;
  if (!element.hasAttribute("data-panel")) return 1000;
  const siblings = [...element.parentElement!.children] as HTMLElement[];
  const panels = siblings.filter((node) => node.hasAttribute("data-panel"));
  const available = 1000 - siblings.filter((node) => node.hasAttribute("data-separator")).length * 5;
  const basis = (node: HTMLElement) => node.style.flexBasis.endsWith("%") ? parseFloat(node.style.flexBasis) / 100 : 0;
  const explicit = panels.reduce((sum, node) => sum + basis(node), 0);
  const totalGrow = panels.reduce((sum, node) => sum + (parseFloat(node.style.flexGrow) || 0), 0);
  return available * (basis(element) || (1 - explicit) * (parseFloat(element.style.flexGrow) || 0) / (totalGrow || 1));
}

function top(element: HTMLElement): number {
  if (!element.parentElement || (!element.hasAttribute("data-panel") && !element.hasAttribute("data-separator"))) return 0;
  const siblings = [...element.parentElement.children];
  return siblings.slice(0, siblings.indexOf(element)).reduce((sum, node) => sum + height(node as HTMLElement), 0);
}

function Editor() {
  useEffect(() => { lifecycle.editorMounts++; return () => { lifecycle.editorUnmounts++; }; }, []);
  return createElement("textarea", { defaultValue: "Unsaved source", "aria-label": "Source" });
}
function Workspace() {
  const [open, setOpen] = useState(true);
  return createElement("div", null,
    createElement("button", { onClick: () => setOpen(true) }, "Open terminal"),
    createElement(EditorTerminalLayout, {
      children: createElement(Editor), tabs: createElement("nav", null, "main.tex"),
      terminal: open ? (controls) => createElement(AgentTerminal, { projectId: "paper", readOnly: false,
        onHide: () => setOpen(false), maximized: controls.maximized, onToggleMaximized: controls.toggleMaximized }) : null
    }));
}
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", LayoutObserver);
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) { return height(this); });
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(1200);
  vi.spyOn(HTMLElement.prototype, "offsetTop", "get").mockImplementation(function (this: HTMLElement) { return top(this); });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    return new DOMRect(0, top(this), 1200, height(this));
  });
  Object.assign(lifecycle, { editorMounts: 0, editorUnmounts: 0, terminalMounts: 0, terminalUnmounts: 0 });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount()); container.remove();
  LayoutObserver.instances.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});
const flush = () => act(async () => { for (const observer of [...LayoutObserver.instances]) observer.flush(); });
const button = (key: string) => container.querySelector<HTMLButtonElement>(`[aria-label="agents.${key}"]`)!;
const source = () => container.querySelector<HTMLDivElement>("#source-editor")!;
async function click(key: string) { await act(async () => button(key).click()); await flush(); }
async function render() { await act(async () => root.render(createElement(Workspace))); await flush(); }

describe("terminal panel maximization", () => {
  it("fills the editor height and restores its previous split without remounting either live surface", async () => {
    await render();
    const editor = container.querySelector("textarea");
    const terminal = container.querySelector("[data-live-terminal]");
    const previousSize = source().style.flexGrow;
    await click("rename");
    expect(container.querySelector(".agent-task-create input")?.getAttribute("value")).toBe("Task");
    await click("maximizeTerminal");
    expect(source().style.flexGrow).toBe("0");
    expect(button("restoreTerminal").getAttribute("aria-pressed")).toBe("true");
    expect(container.querySelector(".source-editor-pane")?.hasAttribute("inert")).toBe(true);
    expect(container.querySelector(".agent-task-create input")).not.toBeNull();
    await click("restoreTerminal");
    expect(source().style.flexGrow).toBe(previousSize);
    expect(button("maximizeTerminal").getAttribute("aria-pressed")).toBe("false");
    expect(container.querySelector(".source-editor-pane")?.hasAttribute("inert")).toBe(false);
    expect(container.querySelector("textarea")).toBe(editor);
    expect(container.querySelector("[data-live-terminal]")).toBe(terminal);
    expect(lifecycle).toEqual({ editorMounts: 1, editorUnmounts: 0, terminalMounts: 1, terminalUnmounts: 0 });
  });

  it("allows the separator to collapse the editor and keeps the maximize control in sync", async () => {
    await render();
    const separator = container.querySelector('[role="separator"]')!;
    expect(separator.getAttribute("aria-label")).toBe("agents.resizeTerminal");
    await act(async () => { separator.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true, cancelable: true })); });
    await flush();
    expect(source().style.flexGrow).toBe("0");
    expect(button("restoreTerminal")).not.toBeNull();
    await click("restoreTerminal");
    expect(Number(source().style.flexGrow)).toBeGreaterThan(0);
    expect(button("maximizeTerminal")).not.toBeNull();
  });

  it("restores a visible editor after closing a maximized terminal and reopens in split mode", async () => {
    await render();
    await click("maximizeTerminal");
    await click("hide");
    expect(container.querySelector("#agent-terminal")).toBeNull();
    expect(container.querySelector(".source-editor-pane")?.hasAttribute("inert")).toBe(false);
    expect(Number(source().style.flexGrow)).toBeGreaterThan(0);
    await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
    await flush();
    expect(button("maximizeTerminal").getAttribute("aria-pressed")).toBe("false");
    expect(lifecycle.editorMounts).toBe(1);
    expect(lifecycle.terminalMounts).toBe(2);
  });
});
