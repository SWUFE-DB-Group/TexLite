import { useEffect, useRef, useState } from "react";
import "../agents/agents.css";
import { ArrowDown, ArrowLeft, ChevronLeft, ChevronRight, Info, LoaderCircle, RefreshCw, Square, TerminalSquare, Trash2, TriangleAlert } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useTerminalPreferences } from "../terminalPreferences";
import { useSuccessNotice } from "../SuccessNotice";
import { SaveButton } from "../SaveButton";
import { api } from "../api";
import { Modal } from "../Dialog";
import { errorMessage } from "../errors";
import type { User } from "../types";
import type { AgentCatalog, AgentPolicy, AgentTask, AgentTaskPage } from "../../shared/agentProtocol";
import { AGENT_LABELS, AGENT_TASK_PAGE_SIZE } from "../../shared/agentProtocol";
import { formatDateTime } from "../dateTime";
import { AgentIcon } from "../agents/AgentIcon";
import { notifyAgentTasksChanged } from "../agents/useAgentAccess";

export function AgentManagement({ user, onBack }: {
  user: User; onBack: () => void;
}) {
  const { t, i18n } = useTranslation();
  const { showExecutionReminder } = useTerminalPreferences();
  const admin = user.role === "admin";
  const prefix = admin ? "/api/admin/agent-tasks" : "/api/agent-tasks";
  const [catalog, setCatalog] = useState<AgentCatalog | null>(null);
  const [policy, setPolicy] = useState<AgentPolicy>({ allowed: [] });
  const [result, setResult] = useState<AgentTaskPage>({ tasks: [], page: 1, pageSize: AGENT_TASK_PAGE_SIZE, total: 0 });
  const [page, setPage] = useState(1);
  const [state, setState] = useState("");
  const [agent, setAgent] = useState("");
  const [project, setProject] = useState("");
  const [owner, setOwner] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const mounted = useRef(true);
  const [error, setError] = useState("");
  const completedAction = useSuccessNotice();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState<AgentTask[]>([]);
  const [failures, setFailures] = useState<Record<string, string>>({});
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    const controller = new AbortController();
    void api<AgentCatalog>(admin ? "/api/admin/agents" : "/api/agents", { signal: controller.signal }).then((value) => {
      setCatalog(value); setPolicy(value.policy);
    }).catch((failure) => { if (!controller.signal.aborted) setError(errorMessage(failure)); });
    return () => controller.abort();
  }, [admin]);
  useEffect(() => {
    let controller: AbortController | undefined;
    let disposed = false;
    const load = () => {
      if (document.visibilityState === "hidden") return;
      controller?.abort(); controller = new AbortController(); const current = controller;
      const params = new URLSearchParams({ page: String(page) });
      if (state) params.set("state", state);
      if (agent) params.set("agent", agent);
      if (project.trim()) params.set("project", project.trim());
      if (owner.trim()) params.set("user", owner.trim());
      void api<AgentTaskPage>(`${prefix}?${params}`, { signal: current.signal }).then((value) => {
        if (!disposed && !current.signal.aborted) { setResult(value); setLoading(false); }
      }).catch((failure) => { if (!disposed && !current.signal.aborted) { setError(errorMessage(failure)); setLoading(false); } });
    };
    const initial = window.setTimeout(load, 150);
    const interval = window.setInterval(load, 5_000);
    window.addEventListener("focus", load);
    return () => { disposed = true; controller?.abort(); window.clearTimeout(initial); window.clearInterval(interval); window.removeEventListener("focus", load); };
  }, [prefix, page, state, agent, project, owner, refresh]);
  const mutate = async (action: () => Promise<void>) => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError(""); completedAction.clear();
    try { await action(); }
    catch (failure) { if (mounted.current) setError(errorMessage(failure)); }
    finally { pending.current = false; notifyAgentTasksChanged(); if (mounted.current) { setBusy(false); setRefresh((value) => value + 1); } }
  };
  const operate = async (tasks: AgentTask[], action: "stop" | "delete") => {
    const results = await Promise.allSettled(tasks.map((task) => api(`${prefix}/${task.id}${action === "stop" ? "/stop" : ""}`, {
      method: action === "stop" ? "POST" : "DELETE"
    })));
    const nextFailures: typeof failures = {};
    const remaining: AgentTask[] = [];
    results.forEach((entry, index) => {
      if (entry.status === "rejected") {
        nextFailures[tasks[index].id] = errorMessage(entry.reason);
        remaining.push(tasks[index]);
      }
    });
    setFailures(nextFailures);
    setSelected(new Set(remaining.map((task) => task.id)));
    if (action === "delete") setDeleting(remaining);
    if (remaining.length) setError(t("agents.operationFailed"));
    else if (action === "stop" && tasks.length === 1) completedAction.show(`stop:${tasks[0].id}`);
  };
  const beginDelete = (tasks: AgentTask[]) => {
    setError(""); setFailures({}); setDeleting(tasks);
  };
  const changeFilter = (setter: (value: string) => void, value: string) => { setter(value); setPage(1); setSelected(new Set()); };
  const selectedTasks = result.tasks.filter((task) => selected.has(task.id));
  return <section className="agent-management management-page">
    <div className="section-title"><div><h1><TerminalSquare size={25} />{t(admin ? "agents.title" : "agents.tasks")}</h1><p>{t(admin ? "agents.description" : "agents.personalDescription")}</p></div>
      <button type="button" className="dashboard-back-button" onClick={onBack}><ArrowLeft size={14} />{t("navigation.backToProjects")}</button></div>
    {error && !deleting.length && <p className="error" role="alert">{error}</p>}
    {admin && <section className="agent-policy-card">
      <div className="agent-policy-heading"><div className="agent-policy-title"><strong>{t("agents.allowedAgents")}</strong>
        <button type="button" className="agent-policy-help" aria-label={t("agents.usageHint")} data-tooltip={t("agents.usageHint")}><Info size={15} aria-hidden="true" /></button>
      </div>
        <div className="agent-policy-actions"><button disabled={busy} onClick={() => void mutate(async () => {
          const value = await api<AgentCatalog>("/api/admin/agents/refresh", { method: "POST" }); setCatalog(value); completedAction.show("detect");
        })}><RefreshCw size={14} /><span role="status">{t(completedAction.message === "detect" ? "common.done" : "agents.detection")}</span></button><SaveButton saving={busy} feedback={completedAction.message === "policy" ? t("editor.saved") : ""} disabled={!catalog} onClick={() => void mutate(async () => {
          const value = await api<AgentCatalog>("/api/admin/agents", { method: "PATCH", body: JSON.stringify(policy) });
          setCatalog(value); setPolicy(value.policy); completedAction.show("policy"); window.dispatchEvent(new Event("texlite:agents-policy"));
        })}>{t("common.save")}</SaveButton></div>
      </div>
      <div className="agent-catalog">{catalog?.agents.map((entry) => <label key={entry.id} className={`agent-catalog-item${entry.installed ? "" : " unavailable"}`}>
        <input type="checkbox" aria-label={`${t("agents.allowed")} ${entry.label}`} disabled={busy} checked={policy.allowed.includes(entry.id)} onChange={(event) => setPolicy((value) => ({ ...value, allowed: event.target.checked ? [...value.allowed, entry.id] : value.allowed.filter((id) => id !== entry.id) }))} />
        <div className="agent-catalog-details"><strong><AgentIcon agent={entry.id} />{entry.label}</strong><small>{entry.installed ? `${t("agents.installed")} · ${entry.version ?? t("agents.unknown")}` : t("agents.notInstalled")}</small></div>
      </label>)}</div>
      {catalog && !catalog.ptyAvailable && <p className="error">{t("agents.ptyUnavailable")}</p>}
    </section>}
    {showExecutionReminder && <p className="agent-list-reminder"><TriangleAlert size={14} aria-hidden="true" /><span>{t("agents.endReminder")}</span></p>}
    <div className="agent-list-controls">
      <select aria-label={t("agents.state")} value={state} onChange={(event) => changeFilter(setState, event.target.value)}>
        <option value="">{t("agents.all")}</option><option value="running">{t("agents.running")}</option><option value="cleanup">{t("agents.cleanup")}</option>
      </select>
      <select aria-label={t("agents.agent")} value={agent} onChange={(event) => changeFilter(setAgent, event.target.value)}><option value="">{t("agents.agent")}</option>{Object.entries(AGENT_LABELS).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select>
      <input aria-label={t("agents.projectFilter")} placeholder={t("agents.projectFilter")} value={project} onChange={(event) => changeFilter(setProject, event.target.value)} />
      {admin && <input aria-label={t("agents.userFilter")} placeholder={t("agents.userFilter")} value={owner} onChange={(event) => changeFilter(setOwner, event.target.value)} />}
      <span className="agent-toolbar-spacer" /><small>{t("agents.taskCount", { count: result.total })}</small>
      <button aria-label={t("agents.refresh")} disabled={busy} onClick={() => setRefresh((value) => value + 1)}><RefreshCw size={14} /></button>
    </div>
    {selectedTasks.length > 0 && <div className="agent-bulk-actions"><span>{t("agents.selected", { count: selectedTasks.length })}</span><button disabled={busy} onClick={() => void mutate(() => operate(selectedTasks, "stop"))}><Square size={13} />{t("agents.batchEnd")}</button><button className="agent-danger" disabled={busy} onClick={() => beginDelete(selectedTasks)}><Trash2 size={13} />{t("agents.batchDelete")}</button></div>}
    <div className="agent-table-scroll table-card"><table className="agent-task-table"><thead><tr><th><input type="checkbox" aria-label={t("agents.all")} checked={result.tasks.length > 0 && result.tasks.every((task) => selected.has(task.id))} onChange={(event) => setSelected(new Set(event.target.checked ? result.tasks.map((task) => task.id) : []))} /></th><th>{t("agents.task")}</th><th>{t("agents.project")}</th>{admin && <th>{t("agents.user")}</th>}<th>{t("agents.agent")}</th><th>{t("agents.state")}</th><th scope="col" aria-sort="descending"><span className="agent-time-heading">{t("agents.updated")}<ArrowDown size={12} aria-hidden="true" /></span></th><th>{t("agents.actions")}</th></tr></thead>
      <tbody>{result.tasks.map((task) => <tr key={task.id} className={selected.has(task.id) ? "selected" : ""}>
        <td><input type="checkbox" aria-label={task.title} checked={selected.has(task.id)} onChange={(event) => setSelected((value) => { const next = new Set(value); if (event.target.checked) next.add(task.id); else next.delete(task.id); return next; })} /></td>
        <td><strong className="agent-task-name" title={task.title}>{task.title}</strong></td>
        <td><span className="agent-task-name" title={task.projectId}>{task.projectName}</span></td>
        {admin && <td><span className="agent-table-user" tabIndex={task.userUsername ? 0 : undefined}
          data-tooltip={task.userUsername ? `@${task.userUsername}` : undefined}>{task.userName}</span></td>}
        <td><span className="agent-identity"><AgentIcon agent={task.agentId} size={15} />{AGENT_LABELS[task.agentId]}</span></td>
        <td><span className={`agent-state-badge ${task.state}`}>{t(`agents.state_${task.state}`)}</span>{task.cleanupState !== "none" && <small className="error">{t("agents.cleanup")}</small>}{task.errorCode && !failures[task.id] && <small className="error">{t(`errors.codes.${task.errorCode}`, { defaultValue: t("agents.taskUnavailable") })}</small>}{failures[task.id] && !deleting.length && <small className="error">{failures[task.id]}</small>}</td>
        <td className="agent-table-time"><time dateTime={task.updatedAt} tabIndex={0}
          data-tooltip={t("agents.createdTooltip", { created: formatDateTime(task.createdAt, i18n.resolvedLanguage) })}
        >{formatDateTime(task.updatedAt, i18n.resolvedLanguage, { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}</time></td>
        <td className="agent-row-actions"><button disabled={busy || !["running", "starting", "stopping"].includes(task.state)} onClick={() => void mutate(() => operate([task], "stop"))}><Square size={12} /><span role="status">{t(completedAction.message === `stop:${task.id}` ? "common.done" : "agents.end")}</span></button><button className="agent-icon-button agent-danger" title={t("agents.delete")} aria-label={t("agents.delete")} disabled={busy} onClick={() => beginDelete([task])}><Trash2 size={14} /></button></td>
      </tr>)}</tbody></table>
      {!result.tasks.length && <div className="agent-task-empty">{loading ? <LoaderCircle size={24} className="spin" /> : <TerminalSquare size={28} />}<strong>{t(loading ? "common.loading" : "agents.noTasks")}</strong>{!loading && <p>{t("agents.noTasksHint")}</p>}</div>}
    </div>
    <nav className="project-pagination agent-pagination" aria-label={t("agents.tasks")}><button type="button" disabled={busy || result.page <= 1} onClick={() => { setPage(result.page - 1); setSelected(new Set()); }}><ChevronLeft size={14} aria-hidden="true" />{t("agents.previous")}</button><span>{result.page} / {Math.max(1, Math.ceil(result.total / result.pageSize))}</span><button type="button" disabled={busy || result.page * result.pageSize >= result.total} onClick={() => { setPage(result.page + 1); setSelected(new Set()); }}>{t("agents.next")}<ChevronRight size={14} aria-hidden="true" /></button></nav>
    <Modal className="management-dialog" open={deleting.length > 0} title={t("agents.delete")} description={t("agents.bulkDeleteDescription")} onOpenChange={(open) => { if (!open && !busy) setDeleting([]); }} footer={<><button disabled={busy} onClick={() => setDeleting([])}>{t("common.cancel")}</button><button className="danger" disabled={busy} onClick={() => void mutate(() => operate(deleting, "delete"))}>{busy && <LoaderCircle size={14} className="spin" />}{t("agents.delete")}</button></>}>
      {deleting.map((task) => <div className="agent-delete-item" key={task.id}><strong>{task.title}</strong><small>{task.projectName} · {task.userName} · {AGENT_LABELS[task.agentId]}</small>{failures[task.id] && <p className="error" role="alert">{failures[task.id]}</p>}</div>)}
    </Modal>
  </section>;
}
