import { formatBytes } from "../formatBytes";
import { lazy, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { api, apiUpload } from "../api";
import { ConfirmDialog, Modal } from "../Dialog";
import type { DashboardData, Project, ProjectCatalogCounts, ProjectListPagination, ProjectOwnershipScope, ProjectTag, SiteConfig, TagColor, User } from "../types";
import i18n from "../i18n";
import { errorMessage } from "../errors";
import { Activity, AlertTriangle, Archive, ArrowDownUp, ArrowLeft, ArrowRightLeft, AtSign, BookMarked, CalendarDays, ChevronLeft, ChevronRight, FileArchive, FolderOpen, FolderPlus, History, LoaderCircle, MessageSquare, Sparkles, Tags, TerminalSquare, Upload, Users, X } from "lucide-react";
import { UserMenu } from "../UserMenu";
import { SiteFooter, SiteLogo } from "./SiteChrome";
import { UpdateNotification } from "../UpdateNotification";
import { ProjectListRow } from "./ProjectListRow";
import { ProjectOwnershipTabs } from "./ProjectOwnershipTabs";
import { ProjectActionMenu } from "./ProjectActionMenu";
import { ProjectIconAvatar } from "../projectIcons";
import { LazyModal, LazyPage } from "../LazyLoadBoundary";
import { appPath, scopedStorageKey } from "../basePath";
import { formatRelativeTime, useRelativeTimeNow } from "../relativeTime";
import { formatDateTime } from "../dateTime";
import { captureDeletionHeight, PROJECT_DELETION_DURATION_MS, useDeletionTransitions } from "../useDeletionTransitions";
import { useAgentAccess } from "../agents/useAgentAccess";
import { useTerminalPreferences } from "../terminalPreferences";

const projectKey = (project: Project) => project.id;
const emptyProjects: Project[] = [];
const requestKey = (ownership: ProjectOwnershipScope, archived: boolean, page: number, search: string, tag: string, sort: "updated" | "created") =>
  JSON.stringify([ownership, archived, page, search, tag, sort]);

const SystemMetricsDialog = lazy(() => import("../SystemMetricsDialog").then((module) => ({ default: module.SystemMetricsDialog })));
const CitationLibraryDialog = lazy(() => import("../CitationLibraryDialog").then((module) => ({ default: module.CitationLibraryDialog })));
const AdminUsers = lazy(() => import("./AdminUsers").then((module) => ({ default: module.AdminUsers })));
const AgentManagement = lazy(() => import("./AgentManagement").then((module) => ({ default: module.AgentManagement })));
const TagManagementDialog = lazy(() => import("./TagManagementDialog").then((module) => ({ default: module.TagManagementDialog })));
const ProjectIconPickerDialog = lazy(() => import("./ProjectIconPickerDialog").then((module) => ({ default: module.ProjectIconPickerDialog })));
const GitHubAccountDialog = lazy(() => import("../GitHubAccountDialog").then((module) => ({ default: module.GitHubAccountDialog })));

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export function Dashboard({ site, user, initialData, onDataChange, onUser, onOpenProject }: {
  site: SiteConfig;
  user: User;
  initialData: DashboardData | null;
  onDataChange: (data: DashboardData) => void;
  onUser: (user: User | null) => void;
  onOpenProject: (id: string, mentionId?: string) => void;
}) {
  const { t } = useTranslation();
  const [projects, setProjects] = useState<Project[]>(() => initialData?.projects ?? []);
  const [tags, setTags] = useState<ProjectTag[]>(() => initialData?.tags ?? []);
  const [pagination, setPagination] = useState<ProjectListPagination>(() => initialData?.pagination ?? {
    page: 1, pageSize: 20, total: initialData?.projects.length ?? 0, totalPages: initialData?.projects.length ? 1 : 0
  });
  const [counts, setCounts] = useState<ProjectCatalogCounts>(() => initialData?.counts ?? { all: 0, owned: 0, shared: 0 });
  const [ownership, setOwnership] = useState<ProjectOwnershipScope>(() => initialData?.filters.ownership ?? "all");
  const [adminOpen, setAdminOpen] = useState(false);
  const [agentsOpen, setAgentsOpen] = useState(false);
  const agentAccess = useAgentAccess(user.id);
  const { showExecutionReminder } = useTerminalPreferences();
  const [metricsOpen, setMetricsOpen] = useState(false);
  const [citationLibraryOpen, setCitationLibraryOpen] = useState(false);
  const [githubAccountOpen, setGitHubAccountOpen] = useState(false);
  const [error, setError] = useState("");
  const [createError, setCreateError] = useState("");
  const [tagAssignmentError, setTagAssignmentError] = useState("");
  const [renameError, setRenameError] = useState("");
  const [duplicateError, setDuplicateError] = useState("");
  const [deleteError, setDeleteError] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [newProjectName, setNewProjectName] = useState("");
  const [creating, setCreating] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importName, setImportName] = useState("");
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importError, setImportError] = useState("");
  const [importPhase, setImportPhase] = useState<"uploading" | "processing" | null>(null);
  const [importProgress, setImportProgress] = useState<number | null>(null);
  const importInput = useRef<HTMLInputElement>(null);
  const tagFilterSidebar = useRef<HTMLElement>(null);
  const [importing, setImporting] = useState(false);
  const [query, setQuery] = useState(() => initialData?.filters.search ?? "");
  const [tagFilter, setTagFilter] = useState(() => initialData?.filters.tag ?? "");
  const [tagFiltersOpen, setTagFiltersOpen] = useState(false);
  const [tagManagerOpen, setTagManagerOpen] = useState(false);
  const [tagProject, setTagProject] = useState<Project | null>(null);
  const [projectIconTarget, setProjectIconTarget] = useState<Project | null>(null);
  const [renameProject, setRenameProject] = useState<Project | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [duplicateProject, setDuplicateProject] = useState<Project | null>(null);
  const [duplicateValue, setDuplicateValue] = useState("");
  const [duplicating, setDuplicating] = useState(false);
  const [deleteProject, setDeleteProject] = useState<Project | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deletedProjectId, setDeletedProjectId] = useState<string | null>(null);
  const [transferProject, setTransferProject] = useState<Project | null>(null);
  const [transferUsers, setTransferUsers] = useState<Array<{ id: string; username: string; displayName?: string }>>([]);
  const [transferUserId, setTransferUserId] = useState("");
  const [transferBusy, setTransferBusy] = useState(false);
  const [transferError, setTransferError] = useState("");
  const [view, setView] = useState<"grid" | "list">(() => localStorage.getItem(scopedStorageKey("texlite-project-view")) === "list" ? "list" : "grid");
  const [sort, setSort] = useState<"updated" | "created">(() => initialData?.filters.sort ?? (localStorage.getItem(scopedStorageKey("texlite-project-sort")) === "created" ? "created" : "updated"));
  const [showArchived, setShowArchived] = useState(() => initialData?.filters.archived ?? false);
  const [archiveBusy, setArchiveBusy] = useState("");
  const [projectMenuId, setProjectMenuId] = useState<string | null>(null);
  const [page, setPage] = useState(() => initialData?.pagination.page ?? 1);
  const relativeTimeNow = useRelativeTimeNow();
  const [loadedKey, setLoadedKey] = useState(() => initialData ? requestKey(initialData.filters.ownership, initialData.filters.archived,
    initialData.pagination.page, initialData.filters.search, initialData.filters.tag, initialData.filters.sort) : "");
  const [refreshVersion, setRefreshVersion] = useState(0);
  const refresh = () => setRefreshVersion((current) => current + 1);
  const requestSequence = useRef(0);
  const loadController = useRef<AbortController | null>(null);
  const currentRequestKey = requestKey(ownership, showArchived, page, query, tagFilter, sort);
  const resultsCurrent = loadedKey === currentRequestKey;
  const { entries: displayedProjects, finishExit } = useDeletionTransitions(resultsCurrent ? projects : emptyProjects, {
    scopeKey: `${currentRequestKey}|${view}|${adminOpen}|${citationLibraryOpen}`,
    deletedKey: deletedProjectId, keyOf: projectKey, duration: PROJECT_DELETION_DURATION_MS
  });
  const load = (scope: ProjectOwnershipScope, archived: boolean, pageNumber: number, search: string, tag: string, order: "updated" | "created") => {
    const params = new URLSearchParams({ page: String(pageNumber), pageSize: "20", sort: order, scope });
    if (archived) params.set("archived", "1");
    if (search.trim()) params.set("search", search.trim());
    if (tag) params.set("tag", tag);
    setError("");
    const sequence = ++requestSequence.current;
    loadController.current?.abort();
    const controller = new AbortController();
    loadController.current = controller;
    return Promise.all([
      api<{ projects: Project[]; pagination: ProjectListPagination; counts: ProjectCatalogCounts }>(`/api/projects?${params.toString()}`, { signal: controller.signal }),
      api<{ tags: ProjectTag[] }>("/api/tags", { signal: controller.signal })
    ]).then(([projectResult, tagResult]) => {
      if (sequence !== requestSequence.current) return;
      setProjects(projectResult.projects); setTags(tagResult.tags); setPagination(projectResult.pagination); setPage(projectResult.pagination.page);
      setCounts(projectResult.counts);
      setLoadedKey(requestKey(scope, archived, projectResult.pagination.page, search, tag, order));
    }).catch((e) => { if (!isAbortError(e) && sequence === requestSequence.current) setError(errorMessage(e)); })
      .finally(() => { if (loadController.current === controller) loadController.current = null; });
  };
  useEffect(() => {
    void load(ownership, showArchived, page, query, tagFilter, sort);
    return () => loadController.current?.abort();
  }, [ownership, showArchived, page, query, tagFilter, sort, refreshVersion]);
  useEffect(() => {
    if (resultsCurrent) onDataChange({ projects, tags, pagination, counts,
      filters: { ownership, archived: showArchived, search: query, tag: tagFilter, sort } });
  }, [projects, tags, pagination, counts, loadedKey, currentRequestKey]);
  useEffect(() => {
    if (!tagFiltersOpen) return;
    const closeWhenOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !tagFilterSidebar.current?.contains(event.target)) setTagFiltersOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setTagFiltersOpen(false);
    };
    document.addEventListener("pointerdown", closeWhenOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeWhenOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [tagFiltersOpen]);
  const changeView = (next: "grid" | "list") => { setProjectMenuId(null); setView(next); localStorage.setItem(scopedStorageKey("texlite-project-view"), next); };
  const changeSort = (next: "updated" | "created") => { setSort(next); setPage(1); localStorage.setItem(scopedStorageKey("texlite-project-sort"), next); };
  const changeOwnership = (next: ProjectOwnershipScope) => {
    if (next === ownership) return;
    setOwnership(next); setPage(1); setProjectMenuId(null);
  };
  const changeScope = (archived: boolean) => { setShowArchived(archived); setPage(1); };
  const changeTagFilter = (next: string) => { setTagFilter(next); setPage(1); };
  const createProject = async () => {
    if (!newProjectName.trim() || creating) return;
    setCreating(true);
    setCreateError("");
    try {
      const { project } = await api<{ project: Project }>("/api/projects", { method: "POST", body: JSON.stringify({ name: newProjectName }) });
      setCreateOpen(false); setNewProjectName("");
      onOpenProject(project.id);
    } catch (e) { setCreateError(errorMessage(e)); }
    finally { setCreating(false); }
  };
  const importProject = async () => {
    if (!importFile) return;
    const file = importFile;
    const maxSize = site.maxUploadSizeMB;
    if (file.size > maxSize * 1024 * 1024) return setImportError(t("errors.fileTooLarge", { size: maxSize }));
    setImporting(true); setImportError(""); setImportPhase("uploading"); setImportProgress(0);
    const data = new FormData();
    data.append("file", file);
    try {
      const { project } = await apiUpload<{ project: Project }>(`/api/projects/import?name=${encodeURIComponent(importName.trim())}`, data, {
        onProgress: (loaded, total) => {
          setImportProgress(total ? Math.min(99, Math.floor(loaded / total * 100)) : null);
        },
        onUploadComplete: () => {
          setImportProgress(null);
          setImportPhase("processing");
        }
      });
      setImportOpen(false); setImportFile(null); setImportName(""); onOpenProject(project.id);
    } catch (e) {
      setImportError(errorMessage(e));
    }
    finally { setImporting(false); setImportPhase(null); setImportProgress(null); }
  };
  const selectImportFile = (file: File | null) => {
    if (importing) return;
    if (file && !file.name.toLocaleLowerCase().endsWith(".zip")) {
      setImportError(t("errors.zipOnly")); return;
    }
    setImportError("");
    setImportFile(file);
    if (file && !importName) setImportName(file.name.replace(/\.zip$/i, ""));
  };
  const logout = async () => {
    await api("/api/auth/logout", { method: "POST" });
    onUser(null);
  };

  const toggleProjectTag = async (tag: ProjectTag) => {
    if (!tagProject) return;
    const assigned = tagProject.tags.some((item) => item.id === tag.id);
    setTagAssignmentError("");
    try {
      const result = await api<{ tags: ProjectTag[]; project: Project }>(
        assigned ? `/api/projects/${tagProject.id}/tags/${tag.id}` : `/api/projects/${tagProject.id}/tags`,
        assigned ? { method: "DELETE" } : { method: "POST", body: JSON.stringify({ tagId: tag.id }) }
      );
      const updated = result.project;
      setTagProject(updated);
      setProjects((current) => current.map((project) => project.id === updated.id ? updated : project));
      refresh();
    } catch (e) { setTagAssignmentError(errorMessage(e)); }
  };

  const addManagedTag = (tag: ProjectTag) => {
    setTags((current) => [...current, tag].sort((left, right) => left.name.localeCompare(right.name)));
  };

  const updateManagedTag = (tag: ProjectTag) => {
    const replaceTag = (current: ProjectTag[]) => current.map((item) => item.id === tag.id ? tag : item);
    setTags((current) => replaceTag(current).sort((left, right) => left.name.localeCompare(right.name)));
    setProjects((current) => current.map((project) => ({ ...project, tags: replaceTag(project.tags) })));
    setTagProject((current) => current ? { ...current, tags: replaceTag(current.tags) } : null);
    refresh();
  };

  const deleteManagedTag = (tagId: string) => {
    setTags((current) => current.filter((tag) => tag.id !== tagId));
    setProjects((current) => current.map((project) => ({ ...project, tags: project.tags.filter((tag) => tag.id !== tagId) })));
    setTagProject((current) => current ? { ...current, tags: current.tags.filter((tag) => tag.id !== tagId) } : null);
    setTagFilter((current) => current === tagId ? "" : current);
    setPage(1);
    refresh();
  };

  const saveProjectIcon = async (projectId: string, icon: string | null) => {
    const result = await api<{ project: Project }>(`/api/projects/${projectId}/icon`, {
      method: "PATCH",
      body: JSON.stringify({ icon })
    });
    setProjects((current) => {
      const updated = current.map((project) => project.id === result.project.id ? result.project : project);
      return sort === "updated"
        ? updated.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.name.localeCompare(right.name))
        : updated;
    });
    refresh();
  };

  const rename = async () => {
    if (!renameProject || !renameValue.trim() || renaming) return;
    setRenaming(true);
    setRenameError("");
    try {
      const result = await api<{ project: Project }>(`/api/projects/${renameProject.id}`, {
        method: "PATCH", body: JSON.stringify({ name: renameValue })
      });
      setProjects((current) => current.map((project) => project.id === result.project.id ? result.project : project));
      setRenameProject(null); setRenameValue("");
      refresh();
    } catch (e) { setRenameError(errorMessage(e)); }
    finally { setRenaming(false); }
  };

  const duplicate = async () => {
    if (!duplicateProject || !duplicateValue.trim()) return;
    setDuplicating(true); setDuplicateError("");
    try {
      await api(`/api/projects/${duplicateProject.id}/duplicate`, {
        method: "POST", body: JSON.stringify({ name: duplicateValue })
      });
      setDuplicateProject(null); setDuplicateValue("");
      refresh();
    } catch (e) { setDuplicateError(errorMessage(e)); }
    finally { setDuplicating(false); }
  };

  const removeProject = async () => {
    if (!deleteProject || deleting) return;
    setDeleting(true);
    setDeleteError("");
    const sequence = requestSequence.current;
    try {
      await api(`/api/projects/${deleteProject.id}`, { method: "DELETE" });
      if (sequence === requestSequence.current) {
        setDeletedProjectId(deleteProject.id);
        removeFromCatalog(deleteProject);
      }
      setDeleteProject(null);
      refresh();
    } catch (e) { setDeleteError(errorMessage(e)); }
    finally { setDeleting(false); }
  };

  const openTransfer = async (project: Project) => {
    setTransferProject(project);
    setTransferUserId("");
    setTransferUsers([]);
    setTransferError("");
    setTransferBusy(true);
    try {
      const result = await api<{ users: Array<{ id: string; username: string; displayName?: string }> }>("/api/users");
      setTransferUsers(result.users.filter((candidate) => candidate.id !== project.ownerId));
    } catch (e) { setTransferError(errorMessage(e)); }
    finally { setTransferBusy(false); }
  };

  const transferOwnership = async () => {
    if (!transferProject || !transferUserId) return;
    setTransferBusy(true);
    setTransferError("");
    try {
      await api(`/api/projects/${transferProject.id}/owner`, {
        method: "PUT", body: JSON.stringify({ userId: transferUserId })
      });
      setTransferProject(null);
      setTransferUserId("");
      refresh();
    } catch (e) { setTransferError(errorMessage(e)); }
    finally { setTransferBusy(false); }
  };

  const removeFromCatalog = (project: Project) => {
    setProjects((current) => current.filter((item) => item.id !== project.id));
    setCounts((current) => ({ ...current, all: Math.max(0, current.all - 1),
      [project.ownerId === user.id ? "owned" : "shared"]: Math.max(0, current[project.ownerId === user.id ? "owned" : "shared"] - 1) }));
    const nextTotal = Math.max(0, pagination.total - 1);
    const totalPages = Math.ceil(nextTotal / pagination.pageSize);
    const nextPage = totalPages === 0 ? 1 : Math.min(page, totalPages);
    setPagination({ ...pagination, page: nextPage, total: nextTotal, totalPages });
    setPage(nextPage);
  };

  const toggleArchive = async (project: Project) => {
    const archive = !showArchived;
    setArchiveBusy(project.id); setError("");
    const sequence = requestSequence.current;
    try {
      await api(`/api/projects/${project.id}/archive`, { method: archive ? "PUT" : "DELETE" });
      if (sequence === requestSequence.current) removeFromCatalog(project);
      refresh();
    } catch (e) { setError(errorMessage(e)); }
    finally { setArchiveBusy(""); }
  };

  const openUnreadMention = async (project: Project) => {
    try {
      const result = await api<{ mentions: Array<{ id: string }> }>(`/api/projects/${project.id}/mentions?unread=1&limit=1`);
      const mention = result.mentions[0];
      onOpenProject(project.id, mention?.id);
    } catch (mentionError) {
      setError(errorMessage(mentionError));
    }
  };

  const formatTime = (value: string) => formatDateTime(value, i18n.resolvedLanguage);
  const formatProjectCreatedDate = (value: string) => {
    return formatDateTime(value, i18n.resolvedLanguage ?? "en", { year: "numeric", month: "2-digit", day: "2-digit" });
  };
  const formatProjectUpdatedTime = (value: string) => formatRelativeTime(
    value,
    i18n.resolvedLanguage ?? "en",
    relativeTimeNow,
    (key, options) => t(key, options)
  );

  return <div className="page">
    <header className="topbar">
      <a className="brand-link" href={appPath("/")} aria-label={site.siteName}><SiteLogo siteName={site.siteName} /><span className="site-title">{site.siteName}</span></a>
      <div className="top-actions">
        {user.role === "admin" && <><button className="ghost" onClick={() => setMetricsOpen(true)}><Activity aria-hidden size={14} />{t("metrics.title")}</button><button className={`ghost${adminOpen ? " top-return-action" : ""}`} onClick={() => { setAdminOpen((current) => !current); setAgentsOpen(false); setCitationLibraryOpen(false); }}>{adminOpen ? <ArrowLeft aria-hidden size={14} /> : <Users aria-hidden size={14} />}{adminOpen ? t("users.back") : t("users.manage")}</button></>}
        <button className={`ghost${citationLibraryOpen ? " top-return-action" : ""}`} onClick={() => { setAdminOpen(false); setAgentsOpen(false); setCitationLibraryOpen((current) => !current); }}>{citationLibraryOpen ? <ArrowLeft aria-hidden size={14} /> : <BookMarked aria-hidden size={14} />}{citationLibraryOpen ? t("users.back") : t("citationLibrary.title")}</button>
        {(user.role === "admin" || agentAccess.visible) && <button className={`ghost${agentsOpen ? " top-return-action" : ""}`} onClick={() => { setAgentsOpen((value) => !value); setAdminOpen(false); setCitationLibraryOpen(false); }}>{agentsOpen ? <ArrowLeft size={14} /> : <TerminalSquare size={14} />}{t(agentsOpen ? "agents.back" : user.role === "admin" ? "agents.title" : "agents.tasks")}
          {showExecutionReminder && !agentsOpen && agentAccess.activeCount > 0 && <sup className="agent-active-count" aria-label={t("agents.activeCount", { count: agentAccess.activeCount })}>{agentAccess.activeCount}</sup>}
        </button>}
        <UserMenu user={user} onGitHub={() => setGitHubAccountOpen(true)} onSignOut={logout} onUserChange={onUser} />
      </div>
    </header>
    {user.role === "admin" && <div className="dashboard-update"><UpdateNotification key={user.id} userId={user.id} /></div>}
    {agentsOpen ? <main className="dashboard"><LazyPage onClose={() => setAgentsOpen(false)}><AgentManagement user={user} onBack={() => setAgentsOpen(false)} /></LazyPage></main> : adminOpen ? <main className="dashboard"><LazyPage onClose={() => setAdminOpen(false)}><AdminUsers currentUser={user} minPasswordLength={site.minPasswordLength} onBack={() => setAdminOpen(false)} /></LazyPage></main> : citationLibraryOpen ? <main className="dashboard">
      <LazyPage onClose={() => setCitationLibraryOpen(false)}><CitationLibraryDialog page open onOpenChange={setCitationLibraryOpen} onBack={() => setCitationLibraryOpen(false)} currentUserId={user.id} maxBibtexBytes={site.maxCitationBibtexBytes} /></LazyPage>
    </main> : <main className="dashboard">
      <div className="section-title"><div><h1><FolderOpen aria-hidden size={25} />{t("projects.title")}</h1><p className="muted">{user.canCreateProjects ? t("projects.subtitle") : t("projects.restricted")}</p></div><div className="section-actions"><button onClick={() => setTagManagerOpen(true)}><Tags aria-hidden size={15} />{t("tags.manage")}</button>{user.canCreateProjects && <><button onClick={() => { setImportError(""); setImportOpen(true); }}><Upload aria-hidden size={15} />{t("projects.upload")}</button><button className="primary" onClick={() => { setCreateError(""); setCreateOpen(true); }}><FolderPlus aria-hidden size={15} />{t("projects.new")}</button></>}</div></div>
      <ProjectOwnershipTabs value={ownership} counts={counts} onChange={changeOwnership} />
      {error && <p className="error">{error}</p>}
      <div className="project-catalog-layout">
        <aside ref={tagFilterSidebar} className={`project-tag-sidebar${tagFilter ? " has-active-filter" : ""}`}>
          <button
            type="button"
            className="project-tag-toggle"
            title={t("projects.filterTags")}
            aria-label={t("projects.filterTags")}
            aria-expanded={tagFiltersOpen}
            aria-controls="dashboard-tag-filters"
            onClick={() => setTagFiltersOpen((current) => !current)}
          >
            <span className="project-tag-toggle-copy"><Tags aria-hidden size={15} /><span>{t("projects.filterTags")}</span></span>
            <ChevronRight className="project-tag-toggle-chevron" aria-hidden size={15} />
          </button>
          {tagFiltersOpen && <div id="dashboard-tag-filters" className="project-tag-filters" role="group" aria-label={t("projects.filterTags")}>
            <button type="button" className={!tagFilter ? "active" : ""} aria-pressed={!tagFilter} onClick={() => changeTagFilter("")}>{t("projects.allTags")}</button>
            {tags.length > 0
              ? tags.map((tag) => <button type="button" key={tag.id} className={tagFilter === tag.id ? "active" : ""} title={tag.name} aria-pressed={tagFilter === tag.id} onClick={() => changeTagFilter(tagFilter === tag.id ? "" : tag.id)}><TagDot color={tag.color} /><span>{tag.name}</span></button>)
              : <p className="project-tag-empty">{t("tags.none")}</p>}
          </div>}
        </aside>
        <div className="project-catalog-content">
          <section id="project-catalog-panel" role="tabpanel" aria-labelledby={`project-tab-${ownership}`} aria-busy={!resultsCurrent && !error}>
          <div className="project-toolbar"><input type="search" placeholder={t("projects.search")} value={query} onChange={(event) => { setQuery(event.target.value); setPage(1); }} /><div className="project-scope" role="group" aria-label={t("projects.scope")}><button className={!showArchived ? "active" : ""} onClick={() => changeScope(false)} aria-pressed={!showArchived}><FolderOpen size={14} />{t("projects.active")}</button><button className={showArchived ? "active" : ""} onClick={() => changeScope(true)} aria-pressed={showArchived}><Archive size={14} />{t("projects.archived")}</button></div><label className="project-sort"><ArrowDownUp size={14} /><span>{t("projects.sortBy")}</span><select value={sort} onChange={(event) => changeSort(event.target.value as "updated" | "created")}><option value="updated">{t("projects.sortModified")}</option><option value="created">{t("projects.sortCreated")}</option></select></label><div className="view-toggle"><button className={view === "grid" ? "active" : ""} onClick={() => changeView("grid")} title={t("projects.grid")}>▦</button><button className={view === "list" ? "active" : ""} onClick={() => changeView("list")} title={t("projects.list")}>☷</button></div></div>
      {!resultsCurrent && !error && <div className="project-catalog-loading" role="status"><LoaderCircle className="spin" size={17} aria-hidden />{t("common.loading")}</div>}
      <div className={`project-grid ${view === "list" ? "list-view" : ""}${projectMenuId ? " project-list-menu-active" : ""}`}>
        {view === "list" && displayedProjects.length > 0 && <div className="project-list-header" aria-hidden="true">
          <span className="project-list-header-avatar" />
          <span>{t("projects.title")}</span>
          <span>{t("projects.owner")}</span>
          <span className="project-list-header-created">{t("projects.created")}</span>
          <span>{t("projects.modified")}</span>
          <span className="project-list-header-mentions">{t("projects.mentionsColumn")}</span>
          <span className="project-list-header-actions">{t("projects.actions")}</span>
        </div>}
        {view === "list"
          ? displayedProjects.map(({ item: project, removeAt }) => <ProjectListRow
            key={project.id}
            project={project}
            removing={removeAt !== null}
            onRemovalEnd={() => finishExit(project.id)}
            currentUser={user}
            showArchived={showArchived}
            archiveBusy={archiveBusy === project.id}
            menuOpen={projectMenuId === project.id}
            t={t}
            formatCreatedDate={formatProjectCreatedDate}
            formatUpdatedTime={formatProjectUpdatedTime}
            formatExactTime={formatTime}
            onOpenProject={() => { setProjectMenuId(null); onOpenProject(project.id); }}
            onOpenMention={() => void openUnreadMention(project)}
            onToggleMenu={() => setProjectMenuId((current) => current === project.id ? null : project.id)}
            onCloseMenu={() => setProjectMenuId((current) => current === project.id ? null : current)}
            onAssignTags={() => { setTagAssignmentError(""); setTagProject(project); }}
            onRename={() => { setRenameError(""); setRenameProject(project); setRenameValue(project.name); }}
            onDuplicate={() => { setDuplicateError(""); setDuplicateProject(project); setDuplicateValue(`${project.name} (1)`); }}
            onArchive={() => void toggleArchive(project)}
            onTransfer={() => void openTransfer(project)}
            onDelete={() => { setDeleteProject(project); setDeleteError(""); }}
            onChooseIcon={() => setProjectIconTarget(project)}
          />)
          : displayedProjects.map(({ item: project, removeAt }) => <article
            key={project.id}
            ref={removeAt !== null ? captureDeletionHeight : undefined}
            inert={removeAt !== null ? true : undefined}
            aria-hidden={removeAt !== null ? true : undefined}
            className={`project-card project-grid-card${project.ownerId === user.id ? " owned-project" : ""}${projectMenuId === project.id ? " project-card-menu-open" : ""}${removeAt !== null ? " deletion-exit" : ""}`}
            onAnimationEnd={(event) => { if (event.target === event.currentTarget && removeAt !== null) finishExit(project.id); }}
            role="button"
            tabIndex={0}
            aria-label={t("projects.openProject", { project: project.name })}
            onClick={() => { setProjectMenuId(null); onOpenProject(project.id); }}
            onKeyDown={(event) => {
              if (event.target !== event.currentTarget || (event.key !== "Enter" && event.key !== " ")) return;
              event.preventDefault();
              setProjectMenuId(null);
              onOpenProject(project.id);
            }}
          >
            <div className="project-card-meta-row">
              <div className="project-card-badges">
                <span className="owner-badge" title={project.ownerDisplayName ?? project.ownerUsername ?? t("projects.deletedUser")}>{project.ownerDisplayName ?? project.ownerUsername ?? t("projects.deletedUser")}</span>
                {Boolean(project.unreadMentionCount && project.unreadMentionCount > 0) && <button className="project-mentions-badge" type="button" title={t("projects.unreadMentionsTooltip", { count: project.unreadMentionCount })} aria-label={t("projects.unreadMentionsTooltip", { count: project.unreadMentionCount })} onClick={(event) => { event.stopPropagation(); void openUnreadMention(project); }}><AtSign aria-hidden size={11} /><span>{project.unreadMentionCount}</span></button>}
              </div>
              <ProjectActionMenu
                variant="grid"
                project={project}
                currentUser={user}
                showArchived={showArchived}
                archiveBusy={archiveBusy === project.id}
                menuOpen={projectMenuId === project.id}
                t={t}
                onToggleMenu={() => setProjectMenuId((current) => current === project.id ? null : project.id)}
                onCloseMenu={() => setProjectMenuId((current) => current === project.id ? null : current)}
                onAssignTags={() => { setTagAssignmentError(""); setTagProject(project); }}
                onRename={() => { setRenameError(""); setRenameProject(project); setRenameValue(project.name); }}
                onDuplicate={() => { setDuplicateError(""); setDuplicateProject(project); setDuplicateValue(`${project.name} (1)`); }}
                onArchive={() => void toggleArchive(project)}
                onTransfer={() => void openTransfer(project)}
                onDelete={() => { setDeleteProject(project); setDeleteError(""); }}
              />
            </div>
            <div className="project-card-title-row">
              <span className="project-card-icon-control" onClick={project.permission === "owner" ? (event) => event.stopPropagation() : undefined}>
                <ProjectIconAvatar
                  icon={project.icon}
                  projectName={project.name}
                  title={project.name}
                  editable={project.permission === "owner"}
                  editLabel={t("projectIcons.change")}
                  onEdit={() => setProjectIconTarget(project)}
                  className="project-card-icon"
                />
              </span>
              <strong className="project-card-title" title={project.name}>{project.name}</strong>
            </div>
            <div className="project-card-tags" aria-label={t("tags.assignTitle", { project: project.name })} title={project.tags?.map((tag) => tag.name).join(", ") || undefined}>
              {project.tags?.map((tag) => <span className={`tag tag-${tag.color}`} key={tag.id} title={tag.name}>{tag.name}</span>)}
            </div>
            <dl className="project-meta">
              <div><dt className="project-meta-created-label"><span><CalendarDays aria-hidden size={13} />{t("projects.created")}</span>{Boolean(project.unresolvedCommentCount && project.unresolvedCommentCount > 0) && <span className="project-comments-badge unresolved" title={t("projects.unresolvedCommentsTooltip", { count: project.commentCount ?? project.unresolvedCommentCount, unresolved: project.unresolvedCommentCount, total: project.commentCount ?? project.unresolvedCommentCount })}><MessageSquare aria-hidden size={11} /><span>{t("projects.unresolvedCount", { count: project.unresolvedCommentCount })}</span></span>}</dt><dd><time dateTime={project.createdAt}>{formatTime(project.createdAt)}</time></dd></div>
              <div><dt><History aria-hidden size={13} />{t("projects.modified")}</dt><dd title={formatTime(project.updatedAt)}><time dateTime={project.updatedAt}>{formatProjectUpdatedTime(project.updatedAt)}</time><span className="project-modified-by"> · {t("projects.byUser", { user: project.lastModifiedDisplayName ?? project.lastModifiedUsername ?? t("projects.deletedUser") })}</span></dd></div>
            </dl>
          </article>)}
        {resultsCurrent && displayedProjects.length === 0 && (query.trim() || tagFilter
          ? <div className="empty">{t("projects.noMatches")}</div>
          : showArchived ? <div className="project-empty project-empty-archived">
              <span className="project-empty-icon"><Archive aria-hidden="true" size={25} strokeWidth={1.5} /></span>
              <h2>{t("projects.noArchived")}</h2>
              <p>{t("projects.noArchivedDescription")}</p>
              <button type="button" className="project-empty-action" onClick={() => changeScope(false)}><ArrowLeft aria-hidden="true" size={14} />{t("projects.backToActive")}</button>
            </div> : ownership === "shared" ? <div className="project-empty"><span className="project-empty-icon"><Users size={28} aria-hidden /></span><h2>{t("projects.noShared")}</h2><p>{t("projects.emptyRestricted")}</p></div>
            : <div className="project-empty"><span className="project-empty-icon"><Sparkles size={28} /></span><h2>{t("projects.emptyTitle")}</h2><p>{user.canCreateProjects ? t("projects.emptyDescription") : t("projects.emptyRestricted")}</p></div>)}
      </div>
      {resultsCurrent && pagination.totalPages > 1 && <nav className="project-pagination" aria-label={t("projects.pagination")}><button disabled={pagination.page <= 1} onClick={() => setPage((current) => Math.max(1, current - 1))} title={t("projects.previousPage")}><ChevronLeft size={15} />{t("projects.previousPage")}</button><span>{t("projects.pageOf", { page: pagination.page, totalPages: pagination.totalPages, count: pagination.total })}</span><button disabled={pagination.page >= pagination.totalPages} onClick={() => setPage((current) => Math.min(pagination.totalPages, current + 1))} title={t("projects.nextPage")}><ChevronRight size={15} />{t("projects.nextPage")}</button></nav>}
          </section>
        </div>
      </div>
      <Modal open={createOpen} title={t("projects.new")} description={t("projects.newDescription")} onOpenChange={(open) => { if (!open && creating) return; setCreateOpen(open); if (!open) setCreateError(""); }} footer={<><button disabled={creating} onClick={() => setCreateOpen(false)}>{t("common.cancel")}</button><button className="primary" disabled={creating || !newProjectName.trim()} aria-busy={creating} onClick={() => void createProject()}>{creating && <LoaderCircle className="spin" size={14} />}{creating ? t("common.loading") : t("common.create")}</button></>}>
        <>{createError && <p className="error dialog-error">{createError}</p>}<label className="form-field">{t("projects.name")}<input autoFocus value={newProjectName} onChange={(event) => { setNewProjectName(event.target.value); setCreateError(""); }} onKeyDown={(event) => { if (event.key === "Enter") void createProject(); }} /></label></>
      </Modal>
      <Modal open={importOpen} title={t("projects.upload")} description={t("projects.uploadDescription", { size: site.maxUploadSizeMB })} onOpenChange={(open) => { if (!open && importing) return; setImportOpen(open); if (!open) setImportError(""); }} footer={<><button disabled={importing} onClick={() => { setImportOpen(false); setImportError(""); }}>{t("common.cancel")}</button><button className="primary" disabled={!importFile || importing} aria-busy={importing} onClick={() => void importProject()}>{importing && <LoaderCircle className="spin" size={14} />}{importing ? t(importPhase === "processing" ? "projects.processing" : "projects.uploading") : t("projects.import")}</button></>}>
        <div className="form-stack">
          {importError && <p className="error import-error">{importError}</p>}
          <div className={`upload-picker${importFile ? " has-file" : ""}${importing ? " is-disabled" : ""}`} onDragOver={(event) => { event.preventDefault(); if (!importing) event.dataTransfer.dropEffect = "copy"; }} onDrop={(event) => { event.preventDefault(); if (!importing) selectImportFile(event.dataTransfer.files[0] ?? null); }}>
            <input ref={importInput} className="sr-only" type="file" accept=".zip,application/zip" disabled={importing} onChange={(event) => selectImportFile(event.target.files?.[0] ?? null)} />
            <FileArchive size={34} />
            <div className="upload-picker-copy"><strong>{importFile?.name ?? t("projects.chooseZip")}</strong><span>{importFile ? t("projects.selectedFileSize", { size: formatBytes(importFile.size, { maximumUnit: "MB" }) }) : t("projects.dropZip")}</span></div>
            <button type="button" disabled={importing} onClick={() => importInput.current?.click()}><Upload size={15} />{t("projects.browse")}</button>
            {importFile && <button className="upload-clear" type="button" disabled={importing} title={t("projects.clearFile")} aria-label={t("projects.clearFile")} onClick={() => { selectImportFile(null); if (importInput.current) importInput.current.value = ""; }}><X size={14} /></button>}
          </div>
          <label className="form-field">{t("projects.name")}<input disabled={importing} value={importName} onChange={(event) => setImportName(event.target.value)} /></label>
          {importing && <div className="project-import-progress" role="status" aria-live="polite">
            <div className="project-import-progress-label"><span>{t(importPhase === "processing" ? "projects.processing" : "projects.uploading")}</span>{importPhase === "uploading" && importProgress !== null && <small aria-hidden="true">{importProgress}%</small>}</div>
            <progress aria-label={t("projects.uploadProgress")} max={100} value={importPhase === "uploading" ? importProgress ?? undefined : undefined} />
            {importPhase === "processing" && <small className="import-progress-hint">{t("projects.processingHint")}</small>}
          </div>}
        </div>
      </Modal>
      {tagManagerOpen && <LazyModal title={t("tags.manage")} onClose={() => setTagManagerOpen(false)}><TagManagementDialog open onOpenChange={setTagManagerOpen} onTagCreated={addManagedTag} onTagUpdated={updateManagedTag} onTagDeleted={deleteManagedTag} /></LazyModal>}
      {projectIconTarget && <LazyModal title={t("projectIcons.title")} onClose={() => setProjectIconTarget(null)}><ProjectIconPickerDialog project={projectIconTarget} open onOpenChange={(open) => { if (!open) setProjectIconTarget(null); }} onSave={saveProjectIcon} /></LazyModal>}
      <Modal open={Boolean(tagProject)} title={t("tags.assignTitle", { project: tagProject?.name ?? "" })} description={t("tags.assignDescription")} onOpenChange={(open) => { if (!open) { setTagProject(null); setTagAssignmentError(""); } }} footer={<button onClick={() => { setTagProject(null); setTagAssignmentError(""); }}>{t("common.close")}</button>}><div className="tag-assignment-list">{tagAssignmentError && <p className="error dialog-error">{tagAssignmentError}</p>}{tags.map((tag) => <label key={tag.id}><input type="checkbox" checked={Boolean(tagProject?.tags.some((item) => item.id === tag.id))} onChange={() => void toggleProjectTag(tag)} /><TagDot color={tag.color} /><span>{tag.name}</span></label>)}{tags.length === 0 && <p className="muted">{t("tags.empty")}</p>}</div></Modal>
      <Modal open={Boolean(renameProject)} title={t("projects.renameTitle")} onOpenChange={(open) => { if (!open && renaming) return; if (!open) { setRenameProject(null); setRenameError(""); } }} footer={<><button disabled={renaming} onClick={() => { setRenameProject(null); setRenameError(""); }}>{t("common.cancel")}</button><button className="primary" disabled={renaming || !renameValue.trim()} aria-busy={renaming} onClick={() => void rename()}>{renaming && <LoaderCircle className="spin" size={14} />}{renaming ? t("common.loading") : t("projects.rename")}</button></>}><>{renameError && <p className="error dialog-error">{renameError}</p>}<label className="form-field">{t("projects.name")}<input autoFocus value={renameValue} onChange={(event) => { setRenameValue(event.target.value); setRenameError(""); }} onKeyDown={(event) => { if (event.key === "Enter") void rename(); }} /></label></></Modal>
      <Modal open={Boolean(duplicateProject)} title={t("projects.duplicateTitle")} description={t("projects.duplicateDescription", { project: duplicateProject?.name ?? "" })} onOpenChange={(open) => { if (!open && !duplicating) { setDuplicateProject(null); setDuplicateValue(""); setDuplicateError(""); } }} footer={<><button disabled={duplicating} onClick={() => { setDuplicateProject(null); setDuplicateValue(""); setDuplicateError(""); }}>{t("common.cancel")}</button><button className="primary" disabled={duplicating || !duplicateValue.trim()} onClick={() => void duplicate()}>{duplicating ? t("projects.duplicating") : t("projects.duplicate")}</button></>}><>{duplicateError && <p className="error dialog-error">{duplicateError}</p>}<label className="form-field">{t("projects.name")}<input autoFocus value={duplicateValue} onChange={(event) => { setDuplicateValue(event.target.value); setDuplicateError(""); }} onKeyDown={(event) => { if (event.key === "Enter") void duplicate(); }} /></label></></Modal>
      <Modal open={Boolean(transferProject)} title={t("projects.transferOwnership")} description={t("projects.transferDescription", { project: transferProject?.name ?? "" })} onOpenChange={(open) => { if (!open && !transferBusy) { setTransferProject(null); setTransferUserId(""); setTransferError(""); } }} footer={<><button disabled={transferBusy} onClick={() => { setTransferProject(null); setTransferUserId(""); setTransferError(""); }}>{t("common.cancel")}</button><button className="primary" disabled={transferBusy || !transferUserId} onClick={() => void transferOwnership()}>{transferBusy ? <LoaderCircle className="spin" size={14} /> : <ArrowRightLeft size={14} />}{t("projects.transfer")}</button></>}><div className="form-stack">{transferError && <p className="error dialog-error">{transferError}</p>}<label className="form-field">{t("projects.newOwner")}<select disabled={transferBusy || transferUsers.length === 0} value={transferUserId} onChange={(event) => setTransferUserId(event.target.value)}><option value="">{transferBusy ? t("common.loading") : transferUsers.length > 0 ? t("projects.chooseNewOwner") : t("projects.noTransferUsers")}</option>{transferUsers.map((candidate) => <option value={candidate.id} key={candidate.id}>{candidate.displayName ?? candidate.username} (@{candidate.username})</option>)}</select></label><p className="warning"><AlertTriangle size={15} />{t("projects.transferWarning")}</p></div></Modal>
      <ConfirmDialog open={Boolean(deleteProject)} title={t("projects.deleteTitle")} description={t("projects.deleteDescription", { project: deleteProject?.name ?? "" })} confirmLabel={deleting ? t("common.loading") : t("common.delete")} danger busy={deleting} error={deleteError} onCancel={() => { if (!deleting) { setDeleteProject(null); setDeleteError(""); } }} onConfirm={() => void removeProject()} />
    </main>}{metricsOpen && <LazyModal title={t("metrics.title")} onClose={() => setMetricsOpen(false)}><SystemMetricsDialog open onOpenChange={setMetricsOpen} /></LazyModal>}{githubAccountOpen && <LazyModal title={t("account.githubTitle")} onClose={() => setGitHubAccountOpen(false)}><GitHubAccountDialog open onOpenChange={setGitHubAccountOpen} /></LazyModal>}
    <SiteFooter />
  </div>;
}

function TagDot({ color }: { color: TagColor }) {
  return <span className={`tag-dot tag-${color}`} />;
}
