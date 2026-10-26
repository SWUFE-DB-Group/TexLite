// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentTerminal } from "../src/client/workspace/AgentTerminal";
import { api } from "../src/client/api";
import type { AgentTask } from "../src/shared/agentProtocol";

vi.mock("../src/client/api", async (original) => ({ ...await original<typeof import("../src/client/api")>(), api: vi.fn() }));
vi.mock("react-i18next", async (original) => ({ ...await original<typeof import("react-i18next")>(),
  useTranslation: () => ({ t: (key: string) => key, i18n: { resolvedLanguage: "en" } }) }));
vi.mock("../src/client/agents/AgentTerminalSurface", () => ({ AgentTerminalSurface: () => createElement("div", { "data-live-terminal": "true" }) }));

function task(id: string, state: AgentTask["state"]): AgentTask {
  return { id, state, title: "a1b2c3", projectId: "paper", projectName: "Paper", userId: "writer", userName: "Writer", agentId: "codex",
    cleanupState: "none", errorCode: null, createdAt: "2026-10-26", updatedAt: "2026-10-26", startedAt: null, endedAt: null,
    exitCode: null, nativeSessionId: null, canResume: false };
}
function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
let root: Root;
let host: HTMLDivElement;
let tasks: AgentTask[];
let start: ReturnType<typeof deferred<{ task: AgentTask }>>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  tasks = []; start = deferred();
  vi.mocked(api).mockReset();
  vi.mocked(api).mockImplementation(async (url, options) => {
    if (url === "/api/agents") return { policy: { allowed: ["codex"] }, ptyAvailable: true,
      agents: [{ id: "codex", label: "Codex", installed: true, enabled: true, version: "1.0.0" }] } as never;
    if (url === "/api/projects/paper/agent-tasks" && options?.method === "POST") {
      const created = task("generated", "ready"); tasks.push(created); return { task: created } as never;
    }
    if (url.endsWith("/start")) return start.promise as Promise<never>;
    return { tasks: [...tasks], page: 1, total: tasks.length, pageSize: 20,
      activeTaskId: tasks.find((value) => value.state === "running")?.id ?? null } as never;
  });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
const render = () => act(async () => root.render(createElement(AgentTerminal, { projectId: "paper", readOnly: false, onHide: vi.fn() })));
const creations = () => vi.mocked(api).mock.calls.filter(([url, options]) => url === "/api/projects/paper/agent-tasks" && options?.method === "POST");
const starts = () => vi.mocked(api).mock.calls.filter(([url]) => url.endsWith("/start"));

describe("one-step optional-name agent tasks", () => {
  it("allows an empty name, creates and starts in one operation, and prevents repeated submission", async () => {
    await render();
    const form = host.querySelector<HTMLFormElement>("form.agent-task-create")!;
    expect(form.querySelector("input")!.required).toBe(false);
    expect(form.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(false);
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(creations()).toHaveLength(1);
    expect(JSON.parse(String(creations()[0][1]?.body))).toMatchObject({ title: "", agentId: "codex" });
    expect(starts()).toHaveLength(1);
    expect(host.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toContain("a1b2c3");
    const running = task("generated", "running"); tasks = [running];
    await act(async () => start.resolve({ task: running }));
    expect(host.querySelector("[data-live-terminal]")).not.toBeNull();
    expect(host.querySelector(".agent-task-state")?.textContent).toBe("agents.state_running");
  });

  it("keeps the same newly created task selected after launch fails, allowing retry without a duplicate", async () => {
    await render();
    await act(async () => host.querySelector("form.agent-task-create")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    await act(async () => start.reject(new Error("Could not launch CLI")));
    expect(host.querySelector(".agent-inline-error")).not.toBeNull();
    expect(host.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toContain("a1b2c3");
    expect(host.querySelector("form.agent-task-create")).toBeNull();
    start = deferred();
    const button = [...host.querySelectorAll<HTMLButtonElement>(".agent-task-toolbar button")].find((value) => value.textContent === "agents.start")!;
    await act(async () => button.click());
    expect(creations()).toHaveLength(1); expect(starts()).toHaveLength(2);
    tasks = [task("generated", "running")];
    await act(async () => start.resolve({ task: tasks[0] }));
    expect(host.querySelector("[data-live-terminal]")).not.toBeNull();
  });

  it("does not create another task for immediate startup while the project already has an active execution", async () => {
    tasks = [task("existing", "running")];
    await render();
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="agents.newTask"]')!.click());
    expect(host.querySelector<HTMLButtonElement>('form.agent-task-create button[type="submit"]')!.disabled).toBe(true);
    expect(host.querySelector(".agent-inline-warning")?.textContent).toContain("errors.codes.AGENT_PROJECT_BUSY");
    await act(async () => host.querySelector("form.agent-task-create")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(creations()).toHaveLength(0);
  });
});
