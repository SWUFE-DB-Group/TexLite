// @vitest-environment happy-dom
import { act, createElement, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TagMarquee } from "../src/client/TagMarquee";

let host: HTMLDivElement, root: Root, viewportWidth: number, trackWidth: number;
let finishFonts: () => void;
let fontDescriptor: PropertyDescriptor | undefined;
const observers: Array<{ callback: () => void; disconnect: ReturnType<typeof vi.fn> }> = [];
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  viewportWidth = 200; trackWidth = 500; observers.length = 0;
  vi.stubGlobal("ResizeObserver", class {
    disconnect = vi.fn(); observe = vi.fn();
    constructor(callback: () => void) { observers.push({ callback, disconnect: this.disconnect }); }
  });
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(() => viewportWidth);
  vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(() => trackWidth);
  fontDescriptor = Object.getOwnPropertyDescriptor(document, "fonts");
  Object.defineProperty(document, "fonts", { configurable: true, value: { ready: new Promise<void>((resolve) => { finishFonts = resolve; }) } });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  if (fontDescriptor) Object.defineProperty(document, "fonts", fontDescriptor);
  else Reflect.deleteProperty(document, "fonts");
});
const row = () => host.querySelector<HTMLElement>(".tag-marquee")!;
const render = (names: string[], focusable = false) => act(async () => root.render(createElement(TagMarquee, {
  className: "example-tags", focusable, children: names.map((name) => createElement("span", { key: name }, name))
})));

it("preserves every full label and enables panning only for an overflowing row", async () => {
  const names = ["Research", "A long label that must remain available", "2026"];
  await render(names);
  expect([...row().querySelectorAll(".tag-marquee-track > span")].map((tag) => tag.textContent)).toEqual(names);
  expect(row().dataset.overflow).toBe("true");
  expect(row().style.getPropertyValue("--tag-marquee-offset")).toBe("-300px");
  expect(row().hasAttribute("tabindex")).toBe(false);
  await render(names, true);
  expect(row().tabIndex).toBe(0);
  viewportWidth = 600;
  await act(async () => observers.at(-1)!.callback());
  expect(row().hasAttribute("data-overflow")).toBe(false);
  expect(row().hasAttribute("tabindex")).toBe(false);
});

it("recalculates after resize, font loading and tag changes instead of retaining an obsolete distance", async () => {
  await render(["First", "Second"]);
  trackWidth = 650;
  await act(async () => finishFonts());
  expect(row().style.getPropertyValue("--tag-marquee-offset")).toBe("-450px");
  viewportWidth = 300;
  await act(async () => observers[0].callback());
  expect(row().style.getPropertyValue("--tag-marquee-offset")).toBe("-350px");
  trackWidth = 100;
  await render(["Only remaining tag"]);
  expect(row().hasAttribute("data-overflow")).toBe(false);
  expect(observers[0].disconnect).toHaveBeenCalledOnce();
});

it("cleans up StrictMode observers and ignores delayed callbacks after unmount", async () => {
  await act(async () => root.render(createElement(StrictMode, null, createElement(TagMarquee, { className: "tags", children: "Research" }))));
  expect(observers).toHaveLength(2);
  expect(observers[0].disconnect).toHaveBeenCalledOnce();
  await act(async () => root.unmount());
  expect(observers[1].disconnect).toHaveBeenCalledOnce();
  const read = vi.mocked(Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollWidth")!.get!);
  const reads = read.mock.calls.length;
  await act(async () => { finishFonts(); observers.forEach((observer) => observer.callback()); });
  expect(read.mock.calls).toHaveLength(reads);
});
