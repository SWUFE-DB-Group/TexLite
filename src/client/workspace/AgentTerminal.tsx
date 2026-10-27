import { lazy, Suspense, useState } from "react";
import "../agents/agents.css";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Info, LoaderCircle, Pencil, Play, Plus, Square, TerminalSquare, Trash2, TriangleAlert, X } from "lucide-react";
import { api } from "../api";
import { Modal } from "../Dialog";
import { useAgentTasks } from "../agents/useAgentTasks";
import type { AgentTask } from "../../shared/agentProtocol";
import { AGENT_LABELS } from "../../shared/agentProtocol";
import { AgentIcon } from "../agents/AgentIcon";
import { AgentSelect } from "../agents/AgentSelect";
import { terminalThemeStyle } from "../terminalTheme";
import { useTerminalPreferences } from "../terminalPreferences";

const AgentTerminalSurface = lazy(() => import("../agents/AgentTerminalSurface").then((module) => ({ default: module.AgentTerminalSurface })));

export function AgentTerminal({ projectId, readOnly, onHide, maximized = false, onToggleMaximized }: {
  projectId: string; readOnly: boolean; onHide: () => void; maximized?: boolean; onToggleMaximized?: () => void;
}) {
  const { t } = useTranslation();
  const tasks = useAgentTasks(projectId);
  const preferences = useTerminalPreferences();
  const task = tasks.selected;
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("");
  const [agentId, setAgentId] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [renameTitle, setRenameTitle] = useState("");
  const [deleteOpen, setDeleteOpen] = useState(false);
  const running = task && ["starting", "running", "stopping"].includes(task.state);
  // A stopped CLI may not have created a native conversation yet. The user is
  // still continuing the same task; the server verifies how it can be launched.
  const resumeTask = task && (task.canResume || task.startedAt !== null || ["stopped", "exited", "interrupted"].includes(task.state));
  const activeAgent = tasks.catalog?.agents.find((agent) => agent.id === task?.agentId);
  const enabledAgents = tasks.catalog?.agents.filter((agent) => agent.installed && agent.enabled) ?? [];
  const creationAgent = agentId ? tasks.catalog?.agents.find((agent) => agent.id === agentId) : enabledAgents[0];
  const projectBusy = Boolean(tasks.result.activeTaskId && tasks.result.activeTaskId !== task?.id);
  const cannotCreate = readOnly || tasks.busy || Boolean(tasks.result.activeTaskId) || !tasks.catalog?.ptyAvailable || !creationAgent?.installed || !creationAgent.enabled;
  const available = !projectBusy && !readOnly && activeAgent?.installed && activeAgent.enabled && tasks.catalog?.ptyAvailable && task?.cleanupState === "none";
  const choose = (id: string) => { tasks.setSelectedId(id); setRenaming(false); };
  const act = (suffix: string) => tasks.mutate(async () => {
    if (!task) return;
    const result = await api<{ task: AgentTask }>(`/api/agent-tasks/${task.id}${suffix}`, { method: "POST" });
    tasks.acceptTask(result.task);
  });
  return <section className="agent-terminal-panel" data-agent-terminal="true" aria-label={t("agents.terminal")}>
    <div className="agent-terminal-heading">
      <strong><TerminalSquare size={14} />{t("agents.terminal")}</strong>
      <button type="button" className="agent-session-help" aria-label={t("agents.sessionManagementHint")}
        data-tooltip={t("agents.sessionManagementHint")} data-texlite-tooltip-always><Info size={13} aria-hidden="true" /></button>
      <div className="agent-task-tabs" role="tablist" aria-label={t("agents.tasks")}>
        {tasks.result.tasks.map((entry) => <button role="tab" type="button" key={entry.id} aria-selected={entry.id === task?.id} title={entry.title} className={entry.id === task?.id ? "active" : ""} onClick={() => choose(entry.id)}>
          <span className={`agent-state-dot ${entry.state}`} /><AgentIcon agent={entry.agentId} size={13} /><span>{entry.title}</span><small>{AGENT_LABELS[entry.agentId]}</small>
        </button>)}
      </div>
      <button className="agent-icon-button" disabled={readOnly || tasks.busy || !enabledAgents.length} title={t("agents.newTask")} aria-label={t("agents.newTask")} onClick={() => setCreating((value) => !value)}><Plus size={15} /></button>
      {onToggleMaximized && <button type="button" className="agent-icon-button" title={t(maximized ? "agents.restoreTerminal" : "agents.maximizeTerminal")} aria-label={t(maximized ? "agents.restoreTerminal" : "agents.maximizeTerminal")} aria-pressed={maximized} onClick={onToggleMaximized}>{maximized ? <ChevronDown size={15} /> : <ChevronUp size={15} />}</button>}
      <button className="agent-icon-button" title={t("agents.hide")} aria-label={t("agents.hide")} onClick={onHide}><X size={15} /></button>
    </div>
    {(task || tasks.result.total > tasks.result.pageSize) && <div className="agent-task-toolbar">
      {tasks.result.total > tasks.result.pageSize && <><button disabled={tasks.result.page <= 1} aria-label={t("agents.previous")} onClick={() => tasks.setPage(tasks.result.page - 1)}><ChevronLeft size={13} /></button><small>{tasks.result.page} / {Math.ceil(tasks.result.total / tasks.result.pageSize)}</small><button disabled={tasks.result.page * tasks.result.pageSize >= tasks.result.total} aria-label={t("agents.next")} onClick={() => tasks.setPage(tasks.result.page + 1)}><ChevronRight size={13} /></button></>}
      {task && <><span className="agent-task-state">{t(`agents.state_${task.state}`)}</span><span className="agent-toolbar-spacer" />
        {running ? <button disabled={tasks.busy} onClick={() => void act("/stop")}><Square size={12} />{t("agents.end")}</button>
          : <button disabled={!available || tasks.busy} onClick={() => void act("/start")}><Play size={13} />{t(resumeTask ? "agents.resume" : "agents.start")}</button>}
        <button className="agent-icon-button" title={t("agents.rename")} aria-label={t("agents.rename")} disabled={tasks.busy} onClick={() => { setRenameTitle(task.title); setRenaming((value) => !value); }}><Pencil size={13} /></button>
        <button className="agent-icon-button agent-danger" title={t("agents.delete")} aria-label={t("agents.delete")} disabled={tasks.busy} onClick={() => { tasks.setError(""); setDeleteOpen(true); }}><Trash2 size={13} /></button>
      </>}
    </div>}
    {(creating || !task) && <form className="agent-task-create" onSubmit={(event) => {
      event.preventDefault();
      if (cannotCreate) return;
      void tasks.mutate(async () => {
        const selectedAgent = creationAgent?.id;
        const response = await api<{ task: AgentTask }>(`/api/projects/${projectId}/agent-tasks`, { method: "POST", body: JSON.stringify({ agentId: selectedAgent, title }) });
        // Keep the created task selected if launch fails so retry never creates
        // a duplicate task or loses its generated name and state directory.
        tasks.acceptTask(response.task); tasks.setPage(1); tasks.setSelectedId(response.task.id); setCreating(false); setTitle("");
        const started = await api<{ task: AgentTask }>(`/api/agent-tasks/${response.task.id}/start`, { method: "POST" });
        tasks.acceptTask(started.task);
      });
    }}>
      <input aria-label={t("agents.task")} placeholder={t("agents.titlePlaceholder")} maxLength={160} value={title} onChange={(event) => setTitle(event.target.value)} disabled={tasks.busy || readOnly} />
      <AgentSelect agents={tasks.catalog?.agents ?? []} value={creationAgent?.id ?? ""} onChange={setAgentId} disabled={readOnly || tasks.busy} />
      <button type="submit" disabled={cannotCreate}>{tasks.busy && <LoaderCircle className="spin" size={13} />}{t("agents.create")}</button>
    </form>}
    {renaming && task && <form className="agent-task-create" onSubmit={(event) => { event.preventDefault(); void tasks.mutate(async () => {
      const result = await api<{ task: AgentTask }>(`/api/agent-tasks/${task.id}`, { method: "PATCH", body: JSON.stringify({ title: renameTitle }) }); tasks.acceptTask(result.task); setRenaming(false);
    }); }}><input value={renameTitle} onChange={(event) => setRenameTitle(event.target.value)} required maxLength={160} aria-label={t("agents.task")} /><button disabled={tasks.busy}>{t("common.save")}</button></form>}
    {tasks.error && !deleteOpen && <p className="error agent-inline-error" role="alert">{tasks.error}<button onClick={() => tasks.setError("")} aria-label={t("common.close")}><X size={13} /></button></p>}
    {task?.errorCode && !tasks.error && !deleteOpen && <p className="error agent-inline-error" role="alert">{t(`errors.codes.${task.errorCode}`, { defaultValue: t("agents.taskUnavailable") })}</p>}
    {(projectBusy || (creating && tasks.result.activeTaskId)) && <p className="agent-inline-warning" role="status"><TriangleAlert size={14} aria-hidden="true" /><span>{t("errors.codes.AGENT_PROJECT_BUSY")}</span></p>}
    {tasks.catalog && !tasks.catalog.ptyAvailable && <p className="error agent-inline-error">{t("agents.ptyUnavailable")}</p>}
    <div className="agent-terminal-body" style={terminalThemeStyle(preferences.theme)}>
      <Suspense fallback={<div className="agent-task-empty"><LoaderCircle className="spin" size={18} /></div>}>
        {task && running && !readOnly ? <AgentTerminalSurface key={task.id} task={task} onTask={tasks.acceptTask} />
            : <div className="agent-task-empty"><TerminalSquare size={24} /><strong>{task?.title || t("agents.noTasks")}</strong><p>{readOnly ? t("agents.permissionLost") : t("agents.readyHint")}</p>{task?.exitCode !== null && task?.exitCode !== undefined && task.exitCode !== 0 && <small>{t("agents.exitCode", { code: task.exitCode })}</small>}</div>}
      </Suspense>
    </div>
    {running && task.state !== "stopping" && <p className="agent-execution-reminder"><TriangleAlert size={12} aria-hidden="true" /><span>{t("agents.endReminder")}</span></p>}
    {task && <Modal open={deleteOpen} title={t("agents.delete")} description={t("agents.deleteDescription")} onOpenChange={(open) => { if (!tasks.busy) setDeleteOpen(open); }} footer={<><button disabled={tasks.busy} onClick={() => setDeleteOpen(false)}>{t("common.cancel")}</button><button className="danger" disabled={tasks.busy} onClick={() => void tasks.mutate(async () => {
      await api(`/api/agent-tasks/${task.id}`, { method: "DELETE" }); setDeleteOpen(false);
    })}>{tasks.busy && <LoaderCircle className="spin" size={13} />}{t("agents.delete")}</button></>}>
      {tasks.error && <p className="error" role="alert">{tasks.error}</p>}
    </Modal>}
  </section>;
}
