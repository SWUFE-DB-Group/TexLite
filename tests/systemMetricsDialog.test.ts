// @vitest-environment happy-dom
import { act, createElement, Fragment, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/client/api";
import { GlobalTooltip } from "../src/client/GlobalTooltip";
import { SystemMetricsDialog } from "../src/client/SystemMetricsDialog";
import "../src/client/i18n";

vi.mock("../src/client/api", () => ({ api: vi.fn() }));
vi.mock("../src/client/Dialog", () => ({
  Modal: ({ open, children, className }: { open: boolean; children: ReactNode; className?: string }) => open ? createElement("section", { className }, children) : null
}));

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(api).mockReset().mockResolvedValue({
    uptimeSeconds: 300, memory: { rssBytes: 256 * 1048576, heapUsedBytes: 0, heapTotalBytes: 0 },
    systemMemory: { scope: "host", usedBytes: 8 * 1024 ** 3, totalBytes: 16 * 1024 ** 3 },
    texMemory: { rssBytes: 512 * 1048576, processCount: 1 },
    cpu: { scope: "host", status: "ready", texlitePercent: 12, otherPercent: 18, idlePercent: 70 },
    compileQueue: { running: 1, concurrency: 10, pending: 0 },
    collaboration: { rooms: 1, sessions: 2, dirtyFiles: 0 },
    eventLoopDelay: { p50Ms: 1, p95Ms: 2, maxMs: 3 }, durationsMs: {}
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe("system resource tooltips", () => {
  it("uses a single custom tooltip for bars and segments, without native titles", async () => {
    await act(async () => root.render(createElement(Fragment, null,
      createElement(SystemMetricsDialog, { open: true, onOpenChange: () => {} }), createElement(GlobalTooltip)
    )));
    const bars = host.querySelectorAll<HTMLElement>(".metric-resource-bar");
    expect(bars).toHaveLength(2);
    for (const bar of bars) {
      for (const target of [bar, ...bar.querySelectorAll<HTMLElement>("[data-tooltip]")]) {
        expect(target.closest("[title]")).toBeNull();
        await act(async () => { target.dispatchEvent(new MouseEvent("pointerover", { bubbles: true })); });
        const tips = host.querySelectorAll('[role="tooltip"]');
        expect(tips).toHaveLength(1);
        expect(tips[0].textContent).toBe(target.getAttribute("data-tooltip"));
        expect(target.closest("[title]")).toBeNull();
        await act(async () => { target.dispatchEvent(new MouseEvent("pointerout", { bubbles: true, relatedTarget: document.body })); });
        expect(host.querySelector('[role="tooltip"]')).toBeNull();
      }
      await act(async () => { bar.dispatchEvent(new FocusEvent("focusin", { bubbles: true })); });
      expect(host.querySelector('[role="tooltip"]')?.textContent).toBe(bar.getAttribute("data-tooltip"));
      await act(async () => { bar.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: document.body })); });
    }
  });
});
