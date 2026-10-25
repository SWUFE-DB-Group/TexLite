// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/client/api";
import { useAgentTasks } from "../src/client/agents/useAgentTasks";
import type { AgentTask, AgentTaskPage } from "../src/shared/agentProtocol";

vi.mock("../src/client/api", () => ({ api: vi.fn() }));
const task = (id: string, state: AgentTask["state"] = "running"): AgentTask => ({
  id, state, projectId: "paper", projectName: "Paper", userId: "writer", userName: "Writer", agentId: "codex",
  title: id, cleanupState: "none", errorCode: null, createdAt: "2026-10-25T00:00:00Z",
  updatedAt: "2026-10-25T00:00:00Z", startedAt: null, endedAt: null, exitCode: null, nativeSessionId: null, canResume: false
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}
const page = (...tasks: AgentTask[]): AgentTaskPage => ({ tasks, page: 1, pageSize: 20, total: tasks.length });
let root: Root;
let container: HTMLDivElement;
let current: ReturnType<typeof useAgentTasks>;
let lists: Array<ReturnType<typeof deferred<AgentTaskPage>>>;
function Harness() { current = useAgentTasks("paper"); return null; }
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  lists = [];
  vi.mocked(api).mockReset();
  vi.mocked(api).mockImplementation((url) => {
    if (url === "/api/agents") return Promise.resolve({ policy: { allowed: ["codex"] }, agents: [], ptyAvailable: true }) as Promise<never>;
    const result = deferred<AgentTaskPage>(); lists.push(result); return result.promise as Promise<never>;
  });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals();
});

describe("agent task request ownership", () => {
  it("does not let a delayed poll overwrite a newer terminal state", async () => {
    await act(async () => root.render(createElement(Harness)));
    await act(async () => lists[0].resolve(page(task("a"))));
    expect(vi.mocked(api).mock.calls.find(([url]) => url.startsWith("/api/agent-tasks?"))?.[0]).not.toContain("archived");
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(lists).toHaveLength(2);
    await act(async () => current.acceptTask(task("a", "exited")));
    await act(async () => lists[1].resolve(page(task("a", "running"))));
    expect(current.selected?.state).toBe("exited");
  });

  it("keeps a newly created task selected when an earlier poll arrives during creation", async () => {
    await act(async () => root.render(createElement(Harness)));
    await act(async () => lists[0].resolve(page(task("a"))));
    await act(async () => window.dispatchEvent(new Event("focus")));
    const done = deferred<void>(); let operation!: Promise<unknown>;
    await act(async () => { operation = current.mutate(async () => {
      await done.promise; current.acceptTask(task("b", "ready")); current.setSelectedId("b");
    }); });
    await act(async () => lists[1].resolve(page(task("a"))));
    await act(async () => { done.resolve(); await operation; });
    expect(current.selected?.id).toBe("b");
    await act(async () => lists.at(-1)!.resolve(page(task("b", "ready"), task("a"))));
    expect(current.selected?.id).toBe("b");
  });

  it("aborts pending lists when unmounted and removes its polling/focus subscriptions", async () => {
    await act(async () => root.render(createElement(Harness)));
    const request = vi.mocked(api).mock.calls.find(([url]) => url.startsWith("/api/agent-tasks?"));
    await act(async () => root.unmount());
    expect(request?.[1]?.signal?.aborted).toBe(true);
    const count = vi.mocked(api).mock.calls.length;
    window.dispatchEvent(new Event("focus")); expect(vi.mocked(api)).toHaveBeenCalledTimes(count);
    // The regular teardown can safely unmount this already-unmounted root.
  });
});
