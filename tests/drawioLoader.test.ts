// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_DRAWIO_EDITOR_URL } from "../src/shared/drawio";

afterEach(() => {
  document.head.querySelectorAll('link[rel="preconnect"]').forEach((link) => link.remove());
  vi.doUnmock("../src/client/workspace/DrawioEditor"); vi.resetModules(); vi.unstubAllGlobals();
});

describe("draw.io intent preloading", () => {
  it("stays lazy until intent, shares the import and never mounts an editor or acquires a lease", async () => {
    const component = vi.fn(), moduleFactory = vi.fn(() => ({ default: component }));
    vi.doMock("../src/client/workspace/DrawioEditor", moduleFactory);
    const socket = vi.fn(), fetch = vi.fn();
    vi.stubGlobal("WebSocket", socket); vi.stubGlobal("fetch", fetch);
    const { loadDrawioEditor, prepareDrawioEditor } = await import("../src/client/workspace/drawioLoader");
    expect(moduleFactory).not.toHaveBeenCalled();
    expect(document.head.querySelector('link[rel="preconnect"]')).toBeNull();
    prepareDrawioEditor(); prepareDrawioEditor();
    const first = loadDrawioEditor();
    expect(loadDrawioEditor()).toBe(first);
    await first;
    expect(moduleFactory).toHaveBeenCalledTimes(1);
    expect(document.head.querySelectorAll(`link[rel="preconnect"][href="${new URL(DEFAULT_DRAWIO_EDITOR_URL).origin}"]`)).toHaveLength(1);
    expect(document.querySelector("iframe")).toBeNull();
    expect(component).not.toHaveBeenCalled(); expect(socket).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });

  it("preconnects only to the configured editor origin, not the URL path or the default server", async () => {
    vi.doMock("../src/client/workspace/DrawioEditor", () => ({ default: vi.fn() }));
    const { loadDrawioEditor, prepareDrawioEditor } = await import("../src/client/workspace/drawioLoader");
    prepareDrawioEditor("https://drawio.example.test:8443/tools/diagrams/");
    await loadDrawioEditor();
    expect([...document.querySelectorAll('link[rel="preconnect"]')].map((link) => link.getAttribute("href")))
      .toEqual(["https://drawio.example.test:8443"]);
  });

  it("allows opening to retry after a failed speculative import", async () => {
    const moduleFactory = vi.fn().mockRejectedValueOnce(new Error("Disconnected")).mockResolvedValue({ default: vi.fn() });
    vi.doMock("../src/client/workspace/DrawioEditor", moduleFactory);
    const { loadDrawioEditor, prepareDrawioEditor } = await import("../src/client/workspace/drawioLoader");
    prepareDrawioEditor();
    await expect(loadDrawioEditor()).rejects.toThrow();
    await expect(loadDrawioEditor()).resolves.toHaveProperty("default");
    expect(moduleFactory).toHaveBeenCalledTimes(2);
  });
});
