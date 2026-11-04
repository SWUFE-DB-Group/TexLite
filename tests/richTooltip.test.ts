// @vitest-environment happy-dom
import { act, createElement, Fragment } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GlobalTooltip, RichTooltip } from "../src/client/GlobalTooltip";

let host: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
const render = (text: string | null, disabled = false) => act(async () => root.render(createElement(Fragment, null,
  createElement("div", { "data-texlite-tooltips": disabled ? "off" : undefined }, text === null ? null : createElement(RichTooltip, {
    text: "Plain fallback", content: createElement("strong", null, text), children: createElement("button", { type: "button" }, "Details")
  }), createElement("button", { title: "Ordinary tooltip", id: "ordinary" }, "Ordinary")), createElement(GlobalTooltip))));
const hover = (selector: string) => act(async () => host.querySelector(selector)!.dispatchEvent(new Event("pointerover", { bubbles: true })));

it("renders React text safely, refreshes hovered content and dismisses it when its owner unmounts", async () => {
  await render("<img src=x onerror=alert(1)>");
  await hover("[data-tooltip-content]");
  expect(host.querySelector('[role="tooltip"] strong')?.textContent).toBe("<img src=x onerror=alert(1)>");
  expect(host.querySelector("img")).toBeNull();
  await render("Updated details");
  expect(host.querySelector('[role="tooltip"] strong')?.textContent).toBe("Updated details");
  await render(null);
  expect(host.querySelector('[role="tooltip"]')).toBeNull();
});

it("shares preference, focus and dismissal behavior with ordinary tooltips", async () => {
  await render("Project details", true);
  await hover("[data-tooltip-content]");
  expect(host.querySelector('[role="tooltip"]')).toBeNull();
  await render("Project details");
  expect(host.querySelector('[role="tooltip"] strong')?.textContent).toBe("Project details");
  await act(async () => host.querySelector<HTMLButtonElement>("[data-tooltip-content]")!.click());
  expect(host.querySelector('[role="tooltip"]')).toBeNull();
  await act(async () => host.querySelector("#ordinary")!.dispatchEvent(new Event("focusin", { bubbles: true })));
  expect(host.querySelector('[role="tooltip"]')?.textContent).toBe("Ordinary tooltip");
  await act(async () => host.querySelector("#ordinary")!.dispatchEvent(new Event("focusout", { bubbles: true })));
  expect(host.querySelector('[role="tooltip"]')).toBeNull();
});
