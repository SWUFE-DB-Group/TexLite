// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SuccessNotice, useSuccessNotice } from "../src/client/SuccessNotice";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
let root: Root;
let host: HTMLDivElement;
let notice: ReturnType<typeof useSuccessNotice>;
function Harness() {
  notice = useSuccessNotice();
  return createElement(SuccessNotice, { message: notice.message, onDismiss: notice.clear });
}
beforeEach(async () => {
  vi.useFakeTimers(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(createElement(Harness)));
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it("shows accessible feedback for two seconds and restarts the timer for an identical repeated save", async () => {
  await act(async () => notice.show("Saved successfully."));
  expect(host.querySelector('[role="status"]')?.textContent).toContain("Saved successfully.");
  await act(async () => vi.advanceTimersByTime(1500));
  await act(async () => notice.show("Saved successfully."));
  await act(async () => vi.advanceTimersByTime(1999));
  expect(host.querySelector('[role="status"]')).not.toBeNull();
  await act(async () => vi.advanceTimersByTime(1));
  expect(host.querySelector('[role="status"]')).toBeNull();
});

it("can be dismissed manually and cancels timers and late feedback on unmount", async () => {
  await act(async () => notice.show("Saved"));
  await act(async () => host.querySelector<HTMLButtonElement>("button")!.click());
  expect(host.textContent).toBe("");
  expect(vi.getTimerCount()).toBe(0);
  await act(async () => notice.show("Saved"));
  await act(async () => root.unmount());
  expect(vi.getTimerCount()).toBe(0);
  notice.show("A late request finished");
  expect(vi.getTimerCount()).toBe(0);
});
