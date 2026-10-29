// @vitest-environment happy-dom
import { act, createElement, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceProjectTitle } from "../src/client/workspace/WorkspaceProjectTitle";

let root: Root, host: HTMLDivElement;
let viewportWidth: number, textWidth: number;
let fontsReady!: () => void;
let fontsDescriptor: PropertyDescriptor | undefined;
const observers: Array<{ callback: () => void; observe: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }> = [];
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  observers.length = 0; viewportWidth = 200; textWidth = 600;
  vi.stubGlobal("ResizeObserver", class {
    observe = vi.fn(); disconnect = vi.fn();
    constructor(callback: () => void) { observers.push({ callback, observe: this.observe, disconnect: this.disconnect }); }
  });
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(() => viewportWidth);
  vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(() => textWidth);
  fontsDescriptor = Object.getOwnPropertyDescriptor(document, "fonts");
  Object.defineProperty(document, "fonts", { configurable: true, value: { ready: new Promise<void>((resolve) => { fontsReady = resolve; }) } });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  if (fontsDescriptor) Object.defineProperty(document, "fonts", fontsDescriptor);
  else Reflect.deleteProperty(document, "fonts");
});
const title = () => host.querySelector<HTMLElement>(".workspace-project-title")!;
const render = (name: string) => act(async () => root.render(createElement(WorkspaceProjectTitle, { name })));

describe("workspace project title", () => {
  it("exposes the full name without tooltips and enables hover/focus panning only when it overflows", async () => {
    const name = "A long research project title with collaborators";
    await render(name);
    expect(title().textContent).toBe(name);
    expect(title().getAttribute("data-overflow")).toBe("true");
    expect(title().tabIndex).toBe(0);
    expect(title().style.getPropertyValue("--project-title-offset")).toBe("-400px");
    expect(host.querySelector("[title], [data-tooltip]")).toBeNull();
    expect(observers[0].observe).toHaveBeenCalledTimes(2);
  });

  it("updates overflow after panel geometry, title text and font metrics change", async () => {
    textWidth = 100; await render("Short name");
    expect(title().hasAttribute("data-overflow")).toBe(false); expect(title().hasAttribute("tabindex")).toBe(false);
    viewportWidth = 80;
    await act(async () => observers[0].callback());
    expect(title().style.getPropertyValue("--project-title-offset")).toBe("-20px");
    expect(title().tabIndex).toBe(0);
    textWidth = 400;
    await act(async () => fontsReady());
    expect(title().style.getPropertyValue("--project-title-offset")).toBe("-320px");
    textWidth = 60; await render("Renamed");
    expect(observers[0].disconnect).toHaveBeenCalledOnce();
    expect(title().hasAttribute("data-overflow")).toBe(false); expect(title().hasAttribute("tabindex")).toBe(false);
  });

  it("cleans observers during StrictMode replay and ignores font completion after unmount", async () => {
    await act(async () => root.render(createElement(StrictMode, null, createElement(WorkspaceProjectTitle, { name: "Long name" }))));
    expect(observers).toHaveLength(2); expect(observers[0].disconnect).toHaveBeenCalledOnce();
    await act(async () => root.unmount());
    expect(observers[1].disconnect).toHaveBeenCalledOnce();
    const reads = vi.mocked(Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollWidth")!.get!).mock.calls.length;
    await act(async () => { fontsReady(); for (const observer of observers) observer.callback(); });
    expect(vi.mocked(Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollWidth")!.get!).mock.calls).toHaveLength(reads);
  });
});
