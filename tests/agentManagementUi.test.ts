// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/client/api";
import { AgentManagement } from "../src/client/pages/AgentManagement";
import { AgentIcon } from "../src/client/agents/AgentIcon";
import { AgentTerminal } from "../src/client/workspace/AgentTerminal";
import { useAgentTasks } from "../src/client/agents/useAgentTasks";
import { agentUiMessages } from "../src/client/agents/messages";
import { formatDateTime } from "../src/client/dateTime";
import { AGENT_IDS, AGENT_LABELS, type AgentCatalog, type AgentTask } from "../src/shared/agentProtocol";
import type { User } from "../src/client/types";

vi.mock("../src/client/api", () => ({ api: vi.fn() }));
vi.mock("../src/client/agents/useAgentTasks", () => ({ useAgentTasks: vi.fn() }));
vi.mock("../src/client/agents/AgentTerminalSurface", () => ({ AgentTerminalSurface: () => createElement("div", { "data-live-terminal": true }) }));
vi.mock("react-i18next", async (importOriginal) => ({ ...await importOriginal<typeof import("react-i18next")>(), useTranslation: () => ({
  t: (key: string, options?: Record<string, unknown>) => {
    const text = key.startsWith("agents.") ? agentUiMessages["zh-Hant"][key.slice(7) as keyof typeof agentUiMessages.en] ?? key : key;
    return text.replace(/{{(\w+)}}/g, (match, name: string) => options?.[name] === undefined ? match : String(options[name]));
  },
  i18n: { resolvedLanguage: "zh-Hant" }
}) }));

const user: User = {
  id: "admin", username: "admin", displayName: "Administrator", role: "admin",
  disabled: false, mustChangePassword: false, canCreateProjects: true, createdAt: "2026-10-25"
};
let root: Root;
let container: HTMLDivElement;
let catalog: AgentCatalog;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  catalog = { policy: { allowed: [] }, ptyAvailable: true,
    agents: AGENT_IDS.map((id) => ({ id, label: AGENT_LABELS[id], installed: id !== "claude",
      enabled: false, version: "1.0.0" })) };
  vi.mocked(api).mockReset();
  vi.mocked(api).mockImplementation(async (url) => url === "/api/admin/agents" ? catalog
    : { tasks: [], page: 1, pageSize: 20, total: 0 } as never);
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove(); vi.useRealTimers(); vi.unstubAllGlobals();
});

describe("coding agent management presentation", () => {
  it.each([null, 0, 7])("keeps terminal hints concise and shows only abnormal exit codes: %s", async (exitCode) => {
    const task: AgentTask = { id: "task", projectId: "paper", projectName: "Paper", userId: user.id, userName: user.displayName,
      agentId: "codex", title: "Revise abstract", state: exitCode === null ? "ready" : "exited", cleanupState: "none", errorCode: null,
      createdAt: "2026-10-25", updatedAt: "2026-10-25", startedAt: null, endedAt: null, exitCode,
      nativeSessionId: exitCode === null ? null : "native-conversation", canResume: exitCode !== null };
    catalog.agents[0].enabled = true;
    vi.mocked(useAgentTasks).mockReturnValue({ catalog, result: { tasks: [task], page: 1, pageSize: 20, total: 1 },
      selected: task, selectedId: task.id, page: 1, busy: false, error: "", setPage: vi.fn(), setSelectedId: vi.fn(), setError: vi.fn(),
      refreshTasks: vi.fn(), acceptTask: vi.fn(), mutate: async (operation) => operation() });
    await act(async () => root.render(createElement(AgentTerminal, { projectId: "paper", readOnly: false, onHide() {} })));
    const empty = container.querySelector(".agent-task-empty");
    expect(empty?.querySelector("p")?.textContent).toBe("啟動或繼續此任務。");
    expect(Boolean(empty?.querySelector("small"))).toBe(exitCode !== null && exitCode !== 0);
    if (exitCode === 7) expect(empty?.querySelector("small")?.textContent).toContain("退出碼");
    const launchLabel = task.canResume ? "繼續任務" : "啟動";
    const launchButtons = [...container.querySelectorAll<HTMLButtonElement>(".agent-task-toolbar button")]
      .filter((button) => button.textContent === "啟動" || button.textContent === "繼續任務" || button.textContent?.includes("新一輪"));
    expect(launchButtons).toHaveLength(1);
    expect(launchButtons[0].textContent).toBe(launchLabel);
    vi.mocked(api).mockResolvedValueOnce({ task });
    await act(async () => launchButtons[0].click());
    expect(api).toHaveBeenCalledWith("/api/agent-tasks/task/start", { method: "POST" });
  });

  it("identifies the feature as a CLI in every locale", () => {
    for (const messages of Object.values(agentUiMessages)) {
      expect(messages.title).toBe("Coding Agent CLI");
      expect(messages.description).toContain("CLI");
    }
  });

  it("visibly reminds active task owners to end execution without turning hide into stop", async () => {
    const task: AgentTask = { id: "task", projectId: "paper", projectName: "Paper", userId: user.id, userName: user.displayName,
      agentId: "codex", title: "Revise abstract", state: "running", cleanupState: "none", errorCode: null,
      createdAt: "2026-10-25", updatedAt: "2026-10-25", startedAt: "2026-10-25", endedAt: null, exitCode: null,
      nativeSessionId: "native-conversation", canResume: true };
    const onHide = vi.fn();
    const acceptTask = vi.fn();
    catalog.agents[0].enabled = true;
    vi.mocked(useAgentTasks).mockReturnValue({ catalog, result: { tasks: [task], page: 1, pageSize: 20, total: 1, activeTaskId: task.id },
      selected: task, selectedId: task.id, page: 1, busy: false, error: "", setPage: vi.fn(), setSelectedId: vi.fn(), setError: vi.fn(),
      refreshTasks: vi.fn(), acceptTask, mutate: async (operation) => operation() });
    const render = () => act(async () => root.render(createElement(AgentTerminal, { projectId: "paper", readOnly: false, onHide })));
    await render();
    const reminder = container.querySelector(".agent-execution-reminder");
    expect(reminder?.textContent).toBe(agentUiMessages["zh-Hant"].endReminder);
    expect(reminder?.closest(".agent-terminal-body")).toBeNull();
    expect(reminder?.hasAttribute("title")).toBe(false);

    await act(async () => container.querySelector<HTMLButtonElement>(`[aria-label="${agentUiMessages["zh-Hant"].hide}"]`)!.click());
    expect(onHide).toHaveBeenCalledOnce();
    expect(api).not.toHaveBeenCalled();

    const stopped = { ...task, state: "stopped" as const };
    vi.mocked(api).mockResolvedValueOnce({ task: stopped });
    const end = [...container.querySelectorAll<HTMLButtonElement>(".agent-task-toolbar button")].find((button) => button.textContent === agentUiMessages["zh-Hant"].end)!;
    await act(async () => end.click());
    expect(api).toHaveBeenCalledWith("/api/agent-tasks/task/stop", { method: "POST" });
    expect(acceptTask).toHaveBeenCalledWith(stopped);
    for (const state of ["stopping", "stopped", "starting"] as const) {
      task.state = state;
      await render();
      expect(Boolean(container.querySelector(".agent-execution-reminder"))).toBe(state === "starting");
    }
  });

  it("gives each agent a distinct local decorative icon", () => {
    const icons = AGENT_IDS.map((agent) => renderToStaticMarkup(createElement(AgentIcon, { agent })));
    expect(new Set(icons).size).toBe(AGENT_IDS.length);
    for (const icon of icons) {
      expect(icon).toContain('aria-hidden="true"');
      expect(icon).toContain('viewBox="0 0 24 24"');
      expect(icon).toContain('fill-rule="evenodd"');
      expect(icon).not.toContain('class="lucide');
      expect(icon).not.toContain("<img");
    }
  });

  it("shows an independent newest-first time column and plain project names, even for an administrator's own task", async () => {
    const task: AgentTask = { id: "admin-task", projectId: "private-paper", projectName: "Private paper", userId: user.id, userName: user.displayName,
      agentId: "codex", title: "Check citations", state: "stopped", cleanupState: "none", errorCode: null, createdAt: "2026-10-25T00:00:00Z",
      updatedAt: "2026-10-25T12:30:00Z", startedAt: null, endedAt: null, exitCode: 0, nativeSessionId: null, canResume: false };
    vi.mocked(api).mockImplementation(async (url) => url === "/api/admin/agents" ? catalog
      : { tasks: [task], page: 1, pageSize: 20, total: 1 } as never);
    await act(async () => root.render(createElement(AgentManagement, { user, onBack() {} })));
    await act(async () => vi.advanceTimersByTime(150));
    expect(container.querySelector('th[aria-sort="descending"]')?.textContent).toBe("最近變更");
    const cells = container.querySelectorAll("tbody tr td");
    expect(cells[1].textContent).toBe(task.title);
    expect(cells[1].querySelector("time, small")).toBeNull();
    expect(cells[2].textContent).toBe(task.projectName);
    expect(cells[2].querySelector("a, button")).toBeNull();
    const time = cells[6].querySelector("time");
    expect(time?.getAttribute("datetime")).toBe(task.updatedAt);
    expect(time?.getAttribute("data-tooltip")).toBe("建立時間：" + formatDateTime(task.createdAt, "zh-Hant"));
    expect(time?.hasAttribute("title")).toBe(false);
    expect(time?.tabIndex).toBe(0);
    expect(time?.textContent).toBe(formatDateTime(task.updatedAt, "zh-Hant", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }));
  });

  it("renders all agent cards with icons and allow controls, without a master switch", async () => {
    await act(async () => root.render(createElement(AgentManagement, { user, onBack() {} })));
    const cards = [...container.querySelectorAll<HTMLLabelElement>(".agent-catalog-item")];
    expect(container.querySelector("h1")?.textContent).toBe("Coding Agent CLI");
    expect(cards).toHaveLength(AGENT_IDS.length);
    cards.forEach((card, index) => {
      expect(card.querySelector("strong")?.textContent).toBe(AGENT_LABELS[AGENT_IDS[index]]);
      expect(card.querySelector(".agent-identity-icon")).not.toBeNull();
      expect(card.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(false);
    });
    expect(container.querySelector('.agent-policy-heading input[type="checkbox"]')).toBeNull();
    const help = container.querySelector<HTMLButtonElement>(".agent-policy-help");
    expect(help?.getAttribute("data-tooltip")).toBe(agentUiMessages["zh-Hant"].isolation);
    expect(help?.getAttribute("aria-label")).toBe(agentUiMessages["zh-Hant"].isolation);
    expect(help?.hasAttribute("title")).toBe(false);
    expect([...container.querySelectorAll(".agent-policy-note")].some((note) => note.textContent?.includes(agentUiMessages["zh-Hant"].isolation))).toBe(false);
    expect(cards.find((card) => card.textContent?.includes("Claude Code"))?.classList.contains("unavailable")).toBe(true);
    await act(async () => vi.advanceTimersByTime(150));
    expect(container.querySelector(".agent-task-empty p")?.textContent).toBe(agentUiMessages["zh-Hant"].noTasksHint);
    expect(container.querySelector(".project-pagination small")).toBeNull();
    const paginationButtons = [...container.querySelectorAll<HTMLButtonElement>(".agent-pagination > button")];
    expect(paginationButtons).toHaveLength(2);
    expect(paginationButtons.map((button) => button.textContent)).toEqual([agentUiMessages["zh-Hant"].previous, agentUiMessages["zh-Hant"].next]);
    expect(container.querySelector('option[value="archived"]')).toBeNull();
  });

  it("presents project execution contention as a warning with an accessible decorative icon", async () => {
    vi.mocked(useAgentTasks).mockReturnValue({ catalog,
      result: { tasks: [], page: 1, pageSize: 20, total: 0, activeTaskId: "another-task" }, selected: null,
      selectedId: "", page: 1, busy: false, error: "", setPage: vi.fn(), setSelectedId: vi.fn(), setError: vi.fn(),
      refreshTasks: vi.fn(), acceptTask: vi.fn(), mutate: async (operation) => operation() });
    await act(async () => root.render(createElement(AgentTerminal, { projectId: "paper", readOnly: false, onHide() {} })));
    const warning = container.querySelector('.agent-inline-warning[role="status"]');
    expect(warning?.textContent).toBe("errors.codes.AGENT_PROJECT_BUSY");
    expect(warning?.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    expect(warning?.querySelector(".lucide-triangle-alert")).not.toBeNull();
    expect(warning?.classList.contains("agent-inline-notice")).toBe(false);
  });
});
