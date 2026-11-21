// @vitest-environment happy-dom
import { act, createElement, lazy } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { LazyPage } from "../src/client/LazyLoadBoundary";
import { recordModuleLoadFailure } from "../src/client/moduleLoadFailure";
import i18n from "../src/client/i18n";

it("offers a manual reload for a failed deferred module without replacing the surrounding UI", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const reload = vi.spyOn(window.location, "reload").mockImplementation(() => {});
  const report = vi.spyOn(console, "error").mockImplementation(() => {});
  const host = document.createElement("div");
  const root = createRoot(host);
  window.addEventListener("vite:preloadError", recordModuleLoadFailure);
  try {
    await i18n.changeLanguage("en");
    const Deferred = lazy(async () => {
      const error = new TypeError("The old chunk is missing");
      const event = Object.assign(new Event("vite:preloadError", { cancelable: true }), { payload: error });
      expect(window.dispatchEvent(event)).toBe(true);
      throw error;
    });
    await act(async () => root.render(createElement("main", null,
      createElement("p", null, "Workspace stays open"),
      createElement(LazyPage, { children: createElement(Deferred) })
    )));
    expect(host.querySelector("p")?.textContent).toBe("Workspace stays open");
    const alert = host.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("Save any changes you can, then reload the page.");
    expect(reload).not.toHaveBeenCalled();
    alert?.querySelector("button")?.click();
    expect(reload).toHaveBeenCalledOnce();
  } finally {
    await act(async () => root.unmount());
    window.removeEventListener("vite:preloadError", recordModuleLoadFailure);
    report.mockRestore();
    reload.mockRestore();
    vi.unstubAllGlobals();
  }
});
