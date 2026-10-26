// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/client/api";
import { notifyAgentTasksChanged, useAgentAccess } from "../src/client/agents/useAgentAccess";
import type { AgentAccess } from "../src/shared/agentProtocol";

vi.mock("../src/client/api", () => ({ api: vi.fn() }));
function deferred() {
  let resolve!: (value: AgentAccess) => void;
  const promise = new Promise<AgentAccess>((done) => { resolve = done; });
  return { promise, resolve };
}
let root: Root;
let host: HTMLDivElement;
let current: AgentAccess;
function Harness({ user, project }: { user: string; project?: string }) {
  current = useAgentAccess(user, project);
  return null;
}
const render = (user = "writer", project?: string) => act(async () => root.render(createElement(Harness, { user, project })));
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  vi.mocked(api).mockReset().mockResolvedValue({ visible: true, activeCount: 2 });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
});

describe("personal active agent badges", () => {
  it("refreshes after local task changes and polls remote exits even without an open terminal", async () => {
    await render();
    expect(api).toHaveBeenCalledWith("/api/agents/access", { signal: expect.any(AbortSignal) });
    expect(current.activeCount).toBe(2);
    vi.mocked(api).mockResolvedValue({ visible: true, activeCount: 1 });
    await act(async () => notifyAgentTasksChanged());
    expect(current.activeCount).toBe(1);
    vi.mocked(api).mockResolvedValue({ visible: true, activeCount: 0 });
    await act(async () => vi.advanceTimersByTime(5_000));
    expect(current.activeCount).toBe(0);
  });

  it("pauses polling in the background and catches up on visibility or focus", async () => {
    await render();
    vi.mocked(api).mockClear();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    await act(async () => {
      vi.advanceTimersByTime(10_000);
      notifyAgentTasksChanged();
    });
    expect(api).not.toHaveBeenCalled();
    vi.mocked(api).mockResolvedValue({ visible: true, activeCount: 0 });
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    expect(current.activeCount).toBe(0);
    vi.mocked(api).mockResolvedValue({ visible: true, activeCount: 1 });
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(current.activeCount).toBe(1);
  });

  it("ignores superseded responses and never carries another user's or project's count across scopes", async () => {
    const first = deferred(), refresh = deferred(), otherUser = deferred(), otherProject = deferred();
    vi.mocked(api).mockReturnValueOnce(first.promise).mockReturnValueOnce(refresh.promise)
      .mockReturnValueOnce(otherUser.promise).mockReturnValueOnce(otherProject.promise);
    await render();
    const firstSignal = vi.mocked(api).mock.calls[0][1]?.signal;
    await act(async () => notifyAgentTasksChanged());
    expect(firstSignal?.aborted).toBe(true);
    await act(async () => refresh.resolve({ visible: true, activeCount: 2 }));
    await act(async () => first.resolve({ visible: true, activeCount: 9 }));
    expect(current.activeCount).toBe(2);

    await render("admin", "paper");
    expect(current.activeCount).toBe(0);
    expect(api).toHaveBeenLastCalledWith("/api/agents/access?project=paper", { signal: expect.any(AbortSignal) });
    const oldProjectSignal = vi.mocked(api).mock.calls.at(-1)![1]?.signal;
    await render("admin", "other-paper");
    expect(oldProjectSignal?.aborted).toBe(true);
    await act(async () => otherUser.resolve({ visible: true, activeCount: 1 }));
    expect(current.activeCount).toBe(0);
    await act(async () => otherProject.resolve({ visible: true, activeCount: 1 }));
    expect(current.activeCount).toBe(1);
  });

  it("aborts pending requests and removes polling and event subscriptions on unmount", async () => {
    const pending = deferred();
    vi.mocked(api).mockReturnValue(pending.promise);
    await render();
    const signal = vi.mocked(api).mock.calls[0][1]?.signal;
    await act(async () => root.render(null));
    expect(signal?.aborted).toBe(true);
    vi.mocked(api).mockClear();
    await act(async () => {
      vi.advanceTimersByTime(10_000);
      notifyAgentTasksChanged();
      window.dispatchEvent(new Event("focus"));
      window.dispatchEvent(new Event("texlite:agents-policy"));
      document.dispatchEvent(new Event("visibilitychange"));
      pending.resolve({ visible: true, activeCount: 1 });
    });
    expect(api).not.toHaveBeenCalled();
  });
});
