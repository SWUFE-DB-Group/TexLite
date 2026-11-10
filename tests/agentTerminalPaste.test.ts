// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/client/api";
import i18n from "../src/client/i18n";
import { AgentTerminal } from "../src/client/workspace/AgentTerminal";
import type { AgentTask, AgentTaskPage } from "../src/shared/agentProtocol";

vi.mock("../src/client/api", async (original) => ({ ...await original<typeof import("../src/client/api")>(), api: vi.fn() }));
vi.mock("../src/client/agents/AgentTerminalSurface", async () => {
  const { createElement } = await import("react");
  return { AgentTerminalSurface: ({ task, pasteRequest }: { task: AgentTask; pasteRequest: { text: string } | null }) =>
    createElement("div", { className: "surface", "data-task": task.id, "data-paste": pasteRequest?.text ?? "" }) };
});

const task = (id: string, state: AgentTask["state"]) => ({ id, state, title: id, agentId: "claude", cleanupState: "none", exitCode: null, errorCode: null, startedAt: null, canResume: false }) as unknown as AgentTask;
const page = (tasks: AgentTask[], activeTaskId: string | null): AgentTaskPage => ({ tasks, page: 1, pageSize: 20, total: tasks.length, activeTaskId });
const active = task("active", "running");
const old = task("old", "stopped");
const request = { id: 1, text: "prompt" };

describe("a paste request in the agent terminal", () => {
  let host: HTMLElement;
  let root: Root;
  let listings: AgentTaskPage[];
  const finished = vi.fn();
  const settle = () => act(async () => { await vi.advanceTimersByTimeAsync(10); await vi.dynamicImportSettled(); await vi.advanceTimersByTimeAsync(10); });
  const render = async (pasteRequest: typeof request | null = request) => {
    await act(async () => root.render(createElement(AgentTerminal, { projectId: "p", readOnly: false, onHide: () => {}, pasteRequest, onPasteFinished: finished })));
    await settle();
  };
  const surface = () => host.querySelector<HTMLElement>(".surface");
  const error = () => host.querySelector(".agent-inline-error")?.textContent ?? "";
  const tab = (id: string) => [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((button) => button.title === id)!;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    await i18n.changeLanguage("en");
    finished.mockClear();
    listings = [];
    vi.mocked(api).mockReset();
    vi.mocked(api).mockImplementation(async (url: string) => (url === "/api/agents"
      ? { agents: [], ptyAvailable: true }
      : listings.length > 1 ? listings.shift() : listings[0]) as never);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("looks at the task list again before refusing a request accepted on a newer count", async () => {
    listings = [page([old], null), page([old, active], "active")];
    await render();
    expect(error()).toBe("");
    expect(finished).not.toHaveBeenCalled();
    expect(surface()?.dataset).toMatchObject({ task: "active", paste: "prompt" });
  });

  it("refuses the request when the fresh list still has no running task", async () => {
    listings = [page([old], null), page([old], null)];
    await render();
    expect(error()).toContain("Start a Coding Agent task first");
    expect(finished).toHaveBeenCalledExactlyOnceWith(1);
  });

  it("drops a request the terminal never took, so it cannot be pasted later", async () => {
    listings = [page([active], "active")];
    await render();
    expect(surface()?.dataset.paste).toBe("prompt");
    await act(async () => { await vi.advanceTimersByTimeAsync(14_000); });
    expect(finished).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(1_100); });
    expect(finished).toHaveBeenCalledExactlyOnceWith(1);
    expect(error()).toContain("Could not paste");
  });

  it("does not time out a request that has already finished", async () => {
    listings = [page([active], "active")];
    await render();
    await render(null);
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(finished).not.toHaveBeenCalled();
    expect(error()).toBe("");
  });

  it("selects the running task once and lets the user move away while the request waits", async () => {
    listings = [page([active, old], "active")];
    await render();
    expect(tab("active").getAttribute("aria-selected")).toBe("true");
    await act(async () => tab("old").click());
    await act(async () => { await vi.advanceTimersByTimeAsync(5_100); });
    expect(tab("old").getAttribute("aria-selected")).toBe("true");
  });
});
