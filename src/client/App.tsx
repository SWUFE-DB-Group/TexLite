import { lazy, Suspense, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { version as texliteVersion } from "../../package.json";
import { api, ApiError, localizedResponseError } from "./api";
import { ConfirmDialog, Modal } from "./Dialog";
import type { FileEntry, LatexCompletionIndex, Project, ProjectListPagination, ProjectTag, SiteConfig, TagColor, User } from "./types";
import { LanguageSwitcher } from "./LanguageSwitcher";
import i18n from "./i18n";
import {
  Activity, AlertTriangle, AlignLeft, Archive, ArchiveRestore, ArrowDownUp, ArrowLeft, ArrowRightLeft, BookOpen, CalendarDays, ChevronDown, ChevronLeft, ChevronRight, Copy, Dices, Download, Eraser, FileArchive, FilePlus2, FileText, Keyboard,
  FileSearch, Folder, FolderOpen, FolderPlus, GitBranch, GripVertical, History, ListTree, LoaderCircle, MessageSquare, MessageSquarePlus, PackageOpen,
  Move, PanelLeftClose, PanelLeftOpen, Pencil, Play, ScrollText,
  Search, Settings, Sparkles, Tags, Trash2, Upload, UserPlus, Users, X, XCircle
} from "lucide-react";
import { Panel, PanelGroup, PanelResizeHandle, type ImperativePanelHandle } from "react-resizable-panels";
import { loadEditorPreferences, saveEditorPreferences, type EditorPreferences } from "./editorPreferences";
import { createLatexTextEdits, isFormattableLatexFile, reindentLatexSelection } from "./latexFormatter";
import { classifyCompileLog } from "./compileLog";
import type { CollaborationSaveReceipt } from "./collaboration";
import { isProjectHistoryState, projectIdFromPath, projectPath, type TexLiteHistoryState } from "./routes";
import { errorMessage } from "./errors";
import type { WorkspaceLayout } from "./workspace/types";
import { CollaborationPresence, WorkspaceLayoutMenu } from "./workspace/WorkspaceChrome";
import { CommentThread, ShareDialog } from "./workspace/Comments";
import { ProjectSettings } from "./workspace/ProjectSettings";
import { CompileArtifacts, CompileCleanup, CompileDiagnosticOutput, CompileOutput } from "./workspace/CompileOutput";
import type { CompileCleanMode } from "./workspace/useProjectCompilation";
import { useProjectComments, type SourceSelection } from "./workspace/useProjectComments";
import { useProjectCollaboration } from "./workspace/useProjectCollaboration";
import { useProjectCompilation } from "./workspace/useProjectCompilation";
import { isEditableTextFile, parentFolders, pathContains, useProjectFiles } from "./workspace/useProjectFiles";
import { useSpellCheck } from "./workspace/useSpellCheck";
import { useSyncTeX } from "./workspace/useSyncTeX";
import { useWorkspaceLayout } from "./workspace/useWorkspaceLayout";
import type { SpellCheckIssue } from "./spellCheck";

const loadPdfPreview = () => import("./PdfPreview");
const PdfPreview = lazy(() => loadPdfPreview().then((module) => ({ default: module.PdfPreview })));
const LatexEditor = lazy(() => import("./LatexEditor").then((module) => ({ default: module.LatexEditor })));
const GitDialog = lazy(() => import("./GitDialog").then((module) => ({ default: module.GitDialog })));
const HistoryDialog = lazy(() => import("./HistoryDialog").then((module) => ({ default: module.HistoryDialog })));
const ProjectSearchDialog = lazy(() => import("./ProjectNavigationDialogs").then((module) => ({ default: module.ProjectSearchDialog })));
const QuickOpenDialog = lazy(() => import("./ProjectNavigationDialogs").then((module) => ({ default: module.QuickOpenDialog })));
const SystemMetricsDialog = lazy(() => import("./SystemMetricsDialog").then((module) => ({ default: module.SystemMetricsDialog })));
const MIN_PASSWORD_LENGTH = 8;

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export function App() {
  const { t } = useTranslation();
  const [site, setSite] = useState<SiteConfig>({ siteName: "TexLite", adminEmail: "" });
  const [user, setUser] = useState<User | null | undefined>();
  const [projectId, setProjectId] = useState<string | null>(() => typeof window === "undefined" ? null : projectIdFromPath(window.location.pathname));
  const [dashboardCache, setDashboardCache] = useState<{ userId: string; projects: Project[]; tags: ProjectTag[]; pagination: ProjectListPagination } | null>(null);

  useEffect(() => {
    const initialProjectId = projectIdFromPath(window.location.pathname);
    if (initialProjectId && window.location.pathname !== projectPath(initialProjectId)) {
      const state: TexLiteHistoryState = { texliteRoute: "project", projectId: initialProjectId, fromDashboard: false };
      window.history.replaceState(state, "", projectPath(initialProjectId));
    }
    const handlePopState = () => setProjectId(projectIdFromPath(window.location.pathname));
    const handleSessionExpired = () => {
      setDashboardCache(null);
      setUser(null);
      if (projectIdFromPath(window.location.pathname)) {
        const state: TexLiteHistoryState = { texliteRoute: "dashboard" };
        window.history.replaceState(state, "", "/");
        setProjectId(null);
      }
    };
    window.addEventListener("popstate", handlePopState);
    window.addEventListener("texlite:session-expired", handleSessionExpired);
    return () => {
      window.removeEventListener("popstate", handlePopState);
      window.removeEventListener("texlite:session-expired", handleSessionExpired);
    };
  }, []);

  const openProject = (id: string) => {
    const nextPath = projectPath(id);
    if (window.location.pathname !== nextPath) {
      const state: TexLiteHistoryState = { texliteRoute: "project", projectId: id, fromDashboard: true };
      window.history.pushState(state, "", nextPath);
    }
    setProjectId(id);
  };
  const leaveProject = () => {
    const state = window.history.state;
    if (isProjectHistoryState(state) && state.fromDashboard) {
      window.history.back();
      return;
    }
    const dashboardState: TexLiteHistoryState = { texliteRoute: "dashboard" };
    window.history.replaceState(dashboardState, "", "/");
    setProjectId(null);
  };

  useEffect(() => {
    void api<SiteConfig>("/api/config").then((config) => {
      setSite(config);
      document.title = config.siteName;
    });
    void api<{ user: User }>("/api/me").then(({ user }) => setUser(user)).catch((error) => {
      if (error instanceof ApiError && error.status === 401) setUser(null);
      else setUser(null);
    });
  }, []);

  if (user === undefined) return <div className="center-card">{t("common.loading")}</div>;
  if (!user) return <Login site={site} onLogin={setUser} />;
  if (user.mustChangePassword) return <ChangePassword site={site} user={user} onChanged={(updated) => setUser(updated)} />;
  if (projectId) {
    return <ProjectWorkspace key={projectId} site={site} user={user} projectId={projectId} onBack={leaveProject} />;
  }
  const cachedDashboard = dashboardCache?.userId === user.id ? dashboardCache : null;
  return <Dashboard site={site} user={user}
    initialData={cachedDashboard ? { projects: cachedDashboard.projects, tags: cachedDashboard.tags, pagination: cachedDashboard.pagination } : null}
    onDataChange={(projects, tags, pagination) => setDashboardCache({ userId: user.id, projects, tags, pagination })}
    onUser={(next) => { if (!next || next.id !== user.id) setDashboardCache(null); setUser(next); if (!next) leaveProject(); }}
    onOpenProject={openProject} />;
}

function SiteLogo({ siteName, compact = false, auth = false }: { siteName: string; compact?: boolean; auth?: boolean }) {
  return <span className={`site-logo${compact ? " compact" : ""}${auth ? " auth-logo" : ""}`}>
    <img src="/logo.svg" alt={siteName} />
  </span>;
}

function SiteFooter() {
  const { t } = useTranslation();
  const repositoryUrl = "https://github.com/SWUFE-DB-Group/TexLite";
  return <footer className="site-footer"><span>{t("footer.copyright", { year: new Date().getFullYear() })} <a href={repositoryUrl} target="_blank" rel="noreferrer">TexLite v{texliteVersion}</a></span><span>{t("footer.credit")}</span></footer>;
}

function ChangePassword({ site, user, onChanged }: { site: SiteConfig; user: User; onChanged: (user: User) => void }) {
  const { t } = useTranslation();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (newPassword !== confirm) return setError(t("auth.mismatch"));
    if (newPassword.length < MIN_PASSWORD_LENGTH) return setError(t("auth.passwordMinimum", { count: MIN_PASSWORD_LENGTH }));
    try {
      await api("/api/me/password", { method: "PUT", body: JSON.stringify({ currentPassword, newPassword }) });
      onChanged({ ...user, mustChangePassword: false });
    } catch (e) { setError(errorMessage(e)); }
  };
  return <main className="login-page"><LanguageSwitcher /><form className="login-card" onSubmit={submit}>
    <SiteLogo siteName={site.siteName} auth /><h1 className="sr-only">{site.siteName}</h1><p className="muted">{t("auth.firstLogin")}</p>
    <label>{t("auth.currentPassword")}<input type="password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} /></label>
    <label>{t("auth.newPassword")}<input type="password" minLength={MIN_PASSWORD_LENGTH} autoComplete="new-password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} /><small className="field-hint">{t("auth.passwordMinimum", { count: MIN_PASSWORD_LENGTH })}</small></label>
    <label>{t("auth.confirmPassword")}<input type="password" minLength={MIN_PASSWORD_LENGTH} autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} /></label>
    {error && <p className="error">{error}</p>}<button className="primary">{t("auth.updatePassword")}</button>
  </form><SiteFooter /></main>;
}

function Login({ site, onLogin }: { site: SiteConfig; onLogin: (user: User) => void }) {
  const { t } = useTranslation();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError("");
    try {
      const result = await api<{ user: User }>("/api/auth/login", {
        method: "POST", body: JSON.stringify({ username, password })
      });
      onLogin(result.user);
    } catch (err) { setError(errorMessage(err)); }
  };
  return <main className="login-page"><LanguageSwitcher />
    <form className="login-card" onSubmit={submit}>
      <SiteLogo siteName={site.siteName} auth />
      <h1 className="sr-only">{site.siteName}</h1>
      <p className="muted">{t("auth.tagline")}</p>
      <label>{t("auth.username")}<input autoFocus value={username} onChange={(e) => setUsername(e.target.value)} /></label>
      <label>{t("auth.password")}<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} /></label>
      {error && <p className="error">{error}</p>}
      <button className="primary" type="submit">{t("auth.login")}</button>
      {site.adminEmail && <small className="support">{t("auth.contact", { email: site.adminEmail })}</small>}
    </form><SiteFooter />
  </main>;
}

function Dashboard({ site, user, initialData, onDataChange, onUser, onOpenProject }: {
  site: SiteConfig;
  user: User;
  initialData: { projects: Project[]; tags: ProjectTag[]; pagination: ProjectListPagination } | null;
  onDataChange: (projects: Project[], tags: ProjectTag[], pagination: ProjectListPagination) => void;
  onUser: (user: User | null) => void;
  onOpenProject: (id: string) => void;
}) {
  const { t } = useTranslation();
  const [projects, setProjects] = useState<Project[]>(() => initialData?.projects ?? []);
  const [tags, setTags] = useState<ProjectTag[]>(() => initialData?.tags ?? []);
  const [pagination, setPagination] = useState<ProjectListPagination>(() => initialData?.pagination ?? {
    page: 1, pageSize: 20, total: initialData?.projects.length ?? 0, totalPages: initialData?.projects.length ? 1 : 0
  });
  const [hasLoaded, setHasLoaded] = useState(Boolean(initialData));
  const [adminOpen, setAdminOpen] = useState(false);
  const [metricsOpen, setMetricsOpen] = useState(false);
  const [error, setError] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [newProjectName, setNewProjectName] = useState("");
  const [importOpen, setImportOpen] = useState(false);
  const [importName, setImportName] = useState("");
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importError, setImportError] = useState("");
  const importInput = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);
  const [query, setQuery] = useState("");
  const [tagFilter, setTagFilter] = useState("");
  const [tagCreateOpen, setTagCreateOpen] = useState(false);
  const [tagName, setTagName] = useState("");
  const [tagColor, setTagColor] = useState<TagColor>("blue");
  const [tagProject, setTagProject] = useState<Project | null>(null);
  const [renameProject, setRenameProject] = useState<Project | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [duplicateProject, setDuplicateProject] = useState<Project | null>(null);
  const [duplicateValue, setDuplicateValue] = useState("");
  const [duplicating, setDuplicating] = useState(false);
  const [deleteProject, setDeleteProject] = useState<Project | null>(null);
  const [transferProject, setTransferProject] = useState<Project | null>(null);
  const [transferUsers, setTransferUsers] = useState<Array<{ id: string; username: string; displayName?: string }>>([]);
  const [transferUserId, setTransferUserId] = useState("");
  const [transferBusy, setTransferBusy] = useState(false);
  const [transferError, setTransferError] = useState("");
  const [view, setView] = useState<"grid" | "list">(() => localStorage.getItem("texlite-project-view") === "list" ? "list" : "grid");
  const [sort, setSort] = useState<"updated" | "created">(() => localStorage.getItem("texlite-project-sort") === "created" ? "created" : "updated");
  const [showArchived, setShowArchived] = useState(false);
  const [archiveBusy, setArchiveBusy] = useState("");
  const [page, setPage] = useState(1);
  const [loadedKey, setLoadedKey] = useState("");
  const requestSequence = useRef(0);
  const loadController = useRef<AbortController | null>(null);
  const requestKey = (archived: boolean, pageNumber: number, search: string, tag: string, order: "updated" | "created") =>
    `${archived ? "archived" : "active"}|${pageNumber}|${search}|${tag}|${order}`;
  const currentRequestKey = requestKey(showArchived, page, query, tagFilter, sort);
  const load = (archived: boolean, pageNumber: number, search: string, tag: string, order: "updated" | "created") => {
    const params = new URLSearchParams({ page: String(pageNumber), pageSize: "20", sort: order });
    if (archived) params.set("archived", "1");
    if (search.trim()) params.set("search", search.trim());
    if (tag) params.set("tag", tag);
    const key = requestKey(archived, pageNumber, search, tag, order);
    const sequence = ++requestSequence.current;
    loadController.current?.abort();
    const controller = new AbortController();
    loadController.current = controller;
    return Promise.all([
      api<{ projects: Project[]; pagination: ProjectListPagination }>(`/api/projects?${params.toString()}`, { signal: controller.signal }),
      api<{ tags: ProjectTag[] }>("/api/tags", { signal: controller.signal })
    ]).then(([projectResult, tagResult]) => {
      if (sequence !== requestSequence.current) return;
      setProjects(projectResult.projects); setTags(tagResult.tags); setPagination(projectResult.pagination); setPage(projectResult.pagination.page);
      setHasLoaded(true); setLoadedKey(key);
    }).catch((e) => { if (!isAbortError(e) && sequence === requestSequence.current) setError(errorMessage(e)); })
      .finally(() => { if (loadController.current === controller) loadController.current = null; });
  };
  useEffect(() => {
    void load(showArchived, page, query, tagFilter, sort);
    return () => loadController.current?.abort();
  }, [showArchived, page, query, tagFilter, sort]);
  useEffect(() => {
    if (hasLoaded && !showArchived && loadedKey === currentRequestKey) onDataChange(projects, tags, pagination);
  }, [projects, tags, pagination, hasLoaded, loadedKey, currentRequestKey, showArchived]);
  const changeView = (next: "grid" | "list") => { setView(next); localStorage.setItem("texlite-project-view", next); };
  const changeSort = (next: "updated" | "created") => { setSort(next); setPage(1); localStorage.setItem("texlite-project-sort", next); };
  const changeScope = (archived: boolean) => { setShowArchived(archived); setPage(1); };
  const changeTagFilter = (next: string) => { setTagFilter(next); setPage(1); };
  const createProject = async () => {
    if (!newProjectName.trim()) return;
    try {
      const { project } = await api<{ project: Project }>("/api/projects", { method: "POST", body: JSON.stringify({ name: newProjectName }) });
      setCreateOpen(false); setNewProjectName("");
      const nextProjects = showArchived || page !== 1 ? projects : [project, ...projects].slice(0, pagination.pageSize);
      const nextPagination = showArchived ? pagination : { ...pagination, total: pagination.total + 1, totalPages: Math.ceil((pagination.total + 1) / pagination.pageSize) };
      setProjects(nextProjects); setPagination(nextPagination); if (!showArchived) onDataChange(nextProjects, tags, nextPagination);
      onOpenProject(project.id);
    } catch (e) { setError(errorMessage(e)); }
  };
  const importProject = async () => {
    if (!importFile) return;
    const maxSize = site.maxUploadSizeMB ?? 50;
    if (importFile.size > maxSize * 1024 * 1024) return setImportError(t("errors.fileTooLarge", { size: maxSize }));
    setImporting(true); setImportError("");
    const data = new FormData(); data.append("file", importFile);
    try {
      const response = await fetch(`/api/projects/import?name=${encodeURIComponent(importName.trim())}`, { method: "POST", body: data });
      const result = await response.json();
      if (!response.ok) throw new Error(localizedResponseError(result, response.status, "errors.upload"));
      const project = result.project as Project;
      const nextProjects = showArchived || page !== 1 ? projects : [project, ...projects].slice(0, pagination.pageSize);
      const nextPagination = showArchived ? pagination : { ...pagination, total: pagination.total + 1, totalPages: Math.ceil((pagination.total + 1) / pagination.pageSize) };
      setProjects(nextProjects); setPagination(nextPagination); if (!showArchived) onDataChange(nextProjects, tags, nextPagination);
      setImportOpen(false); setImportFile(null); setImportName(""); onOpenProject(project.id);
    } catch (e) { setImportError(errorMessage(e)); }
    finally { setImporting(false); }
  };
  const selectImportFile = (file: File | null) => {
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

  const createTag = async () => {
    if (!tagName.trim()) return;
    try {
      const result = await api<{ tag: ProjectTag }>("/api/tags", {
        method: "POST", body: JSON.stringify({ name: tagName, color: tagColor })
      });
      setTags((current) => [...current, result.tag].sort((left, right) => left.name.localeCompare(right.name)));
      setTagCreateOpen(false); setTagName(""); setTagColor("blue");
    } catch (e) { setError(errorMessage(e)); }
  };

  const toggleProjectTag = async (tag: ProjectTag) => {
    if (!tagProject) return;
    const assigned = tagProject.tags.some((item) => item.id === tag.id);
    try {
      const result = await api<{ tags: ProjectTag[]; project: Project }>(
        assigned ? `/api/projects/${tagProject.id}/tags/${tag.id}` : `/api/projects/${tagProject.id}/tags`,
        assigned ? { method: "DELETE" } : { method: "POST", body: JSON.stringify({ tagId: tag.id }) }
      );
      const updated = result.project;
      setTagProject(updated);
      setProjects((current) => current.map((project) => project.id === updated.id ? updated : project));
    } catch (e) { setError(errorMessage(e)); }
  };

  const rename = async () => {
    if (!renameProject || !renameValue.trim()) return;
    try {
      const result = await api<{ project: Project }>(`/api/projects/${renameProject.id}`, {
        method: "PATCH", body: JSON.stringify({ name: renameValue })
      });
      setProjects((current) => current.map((project) => project.id === result.project.id ? result.project : project));
      setRenameProject(null); setRenameValue("");
    } catch (e) { setError(errorMessage(e)); }
  };

  const duplicate = async () => {
    if (!duplicateProject || !duplicateValue.trim()) return;
    setDuplicating(true); setError("");
    try {
      await api(`/api/projects/${duplicateProject.id}/duplicate`, {
        method: "POST", body: JSON.stringify({ name: duplicateValue })
      });
      setDuplicateProject(null); setDuplicateValue("");
      void load(showArchived, page, query, tagFilter, sort);
    } catch (e) { setError(errorMessage(e)); }
    finally { setDuplicating(false); }
  };

  const removeProject = async () => {
    if (!deleteProject) return;
    try {
      await api(`/api/projects/${deleteProject.id}`, { method: "DELETE" });
      setProjects((current) => current.filter((project) => project.id !== deleteProject.id));
      const nextTotal = Math.max(0, pagination.total - 1);
      const nextTotalPages = Math.ceil(nextTotal / pagination.pageSize);
      const nextPage = nextTotalPages === 0 ? 1 : Math.min(page, nextTotalPages);
      const nextPagination = { ...pagination, page: nextPage, total: nextTotal, totalPages: nextTotalPages };
      setPagination(nextPagination);
      setDeleteProject(null);
      if (nextPage !== page) setPage(nextPage);
      else void load(showArchived, page, query, tagFilter, sort);
    } catch (e) { setError(errorMessage(e)); }
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
      void load(showArchived, page, query, tagFilter, sort);
    } catch (e) { setTransferError(errorMessage(e)); }
    finally { setTransferBusy(false); }
  };

  const toggleArchive = async (project: Project) => {
    const archive = !showArchived;
    setArchiveBusy(project.id); setError("");
    try {
      await api(`/api/projects/${project.id}/archive`, { method: archive ? "PUT" : "DELETE" });
      const nextProjects = projects.filter((item) => item.id !== project.id);
      setProjects(nextProjects);
      const nextTotal = Math.max(0, pagination.total - 1);
      const nextTotalPages = Math.ceil(nextTotal / pagination.pageSize);
      const nextPage = nextTotalPages === 0 ? 1 : Math.min(page, nextTotalPages);
      const nextPagination = { ...pagination, page: nextPage, total: nextTotal, totalPages: nextTotalPages };
      setPagination(nextPagination);
      if (!showArchived) onDataChange(nextProjects, tags, nextPagination);
      if (nextPage !== page) setPage(nextPage);
      else void load(showArchived, page, query, tagFilter, sort);
    } catch (e) { setError(errorMessage(e)); }
    finally { setArchiveBusy(""); }
  };

  const filtered = projects;
  const colors: TagColor[] = ["red", "orange", "yellow", "green", "blue", "purple", "gray"];
  const formatTime = (value: string) => new Date(value).toLocaleString(i18n.resolvedLanguage);

  return <div className="page">
    <header className="topbar">
      <span className="site-title">{site.siteName}</span><SiteLogo siteName={site.siteName} />
      <div className="top-actions">
        {user.role === "admin" && <><button className="ghost" onClick={() => setMetricsOpen(true)}><Activity aria-hidden size={14} />{t("metrics.title")}</button><button className="ghost" onClick={() => setAdminOpen(!adminOpen)}>{adminOpen ? <ArrowLeft aria-hidden size={14} /> : <Users aria-hidden size={14} />}{adminOpen ? t("users.back") : t("users.manage")}</button></>}
        <LanguageSwitcher compact /><span className="top-user-identity"><strong>{user.displayName}</strong><small>@{user.username}</small></span><button className="ghost" onClick={logout}>{t("auth.logout")}</button>
      </div>
    </header>
    {adminOpen ? <AdminUsers currentUser={user} /> : <main className="dashboard">
      <div className="section-title"><div><h1><FolderOpen aria-hidden size={25} />{t("projects.title")}</h1><p className="muted">{user.canCreateProjects ? t("projects.subtitle") : t("projects.restricted")}</p></div><div className="section-actions"><button onClick={() => setTagCreateOpen(true)}><Tags aria-hidden size={15} />{t("tags.create")}</button>{user.canCreateProjects && <><button onClick={() => { setImportError(""); setImportOpen(true); }}><Upload aria-hidden size={15} />{t("projects.upload")}</button><button className="primary" onClick={() => setCreateOpen(true)}><FolderPlus aria-hidden size={15} />{t("projects.new")}</button></>}</div></div>
      {error && <p className="error">{error}</p>}
      <div className="project-toolbar"><input type="search" placeholder={t("projects.search")} value={query} onChange={(event) => { setQuery(event.target.value); setPage(1); }} /><div className="project-scope" role="tablist" aria-label={t("projects.scope")}><button className={!showArchived ? "active" : ""} onClick={() => changeScope(false)} role="tab" aria-selected={!showArchived}><FolderOpen size={14} />{t("projects.active")}</button><button className={showArchived ? "active" : ""} onClick={() => changeScope(true)} role="tab" aria-selected={showArchived}><Archive size={14} />{t("projects.archived")}</button></div><div className="tag-filters"><button className={!tagFilter ? "active" : ""} onClick={() => changeTagFilter("")}>{t("projects.allTags")}</button>{tags.map((tag) => <button key={tag.id} className={tagFilter === tag.id ? "active" : ""} onClick={() => changeTagFilter(tagFilter === tag.id ? "" : tag.id)}><TagDot color={tag.color} />{tag.name}</button>)}</div><label className="project-sort"><ArrowDownUp size={14} /><span>{t("projects.sortBy")}</span><select value={sort} onChange={(event) => changeSort(event.target.value as "updated" | "created")}><option value="updated">{t("projects.sortModified")}</option><option value="created">{t("projects.sortCreated")}</option></select></label><div className="view-toggle"><button className={view === "grid" ? "active" : ""} onClick={() => changeView("grid")} title={t("projects.grid")}>▦</button><button className={view === "list" ? "active" : ""} onClick={() => changeView("list")} title={t("projects.list")}>☷</button></div></div>
      <div className={`project-grid ${view === "list" ? "list-view" : ""}`}>
        {filtered.map((project) => <article className={`project-card${project.ownerId === user.id ? " owned-project" : ""}`} key={project.id}>
          {view === "grid" && project.ownerId === user.id && <button className="project-transfer-action" title={t("projects.transferOwnership")} onClick={() => void openTransfer(project)}><ArrowRightLeft aria-hidden size={13} />{t("projects.transfer")}</button>}
          <button className="project-card-open" onClick={() => onOpenProject(project.id)}>
            <span className="owner-badge" title={project.ownerDisplayName ?? project.ownerUsername}>{project.ownerDisplayName ?? project.ownerUsername}</span>
            <span className="project-card-main">
              <strong>{project.name}</strong>
              <span className="project-tags">
                {project.tags?.map((tag) => <span className={`tag tag-${tag.color}`} key={tag.id}>{tag.name}</span>)}
                {Boolean(project.unresolvedCommentCount && project.unresolvedCommentCount > 0) && (
                  <span className="project-comments-badge unresolved" title={t("projects.unresolvedCommentsTooltip", { unresolved: project.unresolvedCommentCount, total: project.commentCount ?? project.unresolvedCommentCount })}>
                    <MessageSquare aria-hidden size={10} />
                    <span>{t("projects.unresolvedCount", { count: project.unresolvedCommentCount })}</span>
                  </span>
                )}
              </span>
            </span>
            <dl className="project-meta">
              <div><dt><CalendarDays aria-hidden size={13} />{t("projects.created")}</dt><dd><time dateTime={project.createdAt}>{formatTime(project.createdAt)}</time></dd></div>
              <div><dt><History aria-hidden size={13} />{t("projects.modified")}</dt><dd title={t("projects.modifiedByUser", { time: formatTime(project.updatedAt), user: project.lastModifiedDisplayName ?? project.lastModifiedUsername ?? t("projects.deletedUser") })}><time dateTime={project.updatedAt}>{formatTime(project.updatedAt)}</time><span className="project-modified-by"> · {t("projects.byUser", { user: project.lastModifiedDisplayName ?? project.lastModifiedUsername ?? t("projects.deletedUser") })}</span></dd></div>
            </dl>
          </button>
          <div className="project-card-actions">
            <button onClick={() => setTagProject(project)}><Tags aria-hidden size={14} />{t("tags.assign")}</button>
            {project.permission === "owner" && <button onClick={() => { setRenameProject(project); setRenameValue(project.name); }}><Pencil aria-hidden size={14} />{t("projects.rename")}</button>}
            {(user.role === "admin" || user.canCreateProjects) && <button onClick={() => { setDuplicateProject(project); setDuplicateValue(`${project.name} (1)`); }}><Copy aria-hidden size={14} />{t("projects.duplicate")}</button>}
            <a href={`/api/projects/${project.id}/download`} download><Download aria-hidden size={14} />{t("projects.download")}</a>
            <button disabled={archiveBusy === project.id} onClick={() => void toggleArchive(project)}>{showArchived ? <ArchiveRestore aria-hidden size={14} /> : <Archive aria-hidden size={14} />}{showArchived ? t("projects.unarchive") : t("projects.archive")}</button>
            {view === "list" && project.ownerId === user.id && <button onClick={() => void openTransfer(project)}><ArrowRightLeft aria-hidden size={14} />{t("projects.transfer")}</button>}
            {project.permission === "owner" && <button className="danger-text" onClick={() => setDeleteProject(project)}><Trash2 aria-hidden size={14} />{t("common.delete")}</button>}
          </div>
        </article>)}
        {filtered.length === 0 && (projects.length === 0
          ? showArchived ? <div className="empty">{t("projects.noArchived")}</div> : <div className="project-empty"><span className="project-empty-icon"><Sparkles size={28} /></span><h2>{t("projects.emptyTitle")}</h2><p>{user.canCreateProjects ? t("projects.emptyDescription") : t("projects.emptyRestricted")}</p></div>
          : <div className="empty">{t("projects.noMatches")}</div>)}
      </div>
      {pagination.totalPages > 1 && <nav className="project-pagination" aria-label={t("projects.pagination")}><button disabled={pagination.page <= 1} onClick={() => setPage((current) => Math.max(1, current - 1))} title={t("projects.previousPage")}><ChevronLeft size={15} />{t("projects.previousPage")}</button><span>{t("projects.pageOf", { page: pagination.page, totalPages: pagination.totalPages, count: pagination.total })}</span><button disabled={pagination.page >= pagination.totalPages} onClick={() => setPage((current) => Math.min(pagination.totalPages, current + 1))} title={t("projects.nextPage")}><ChevronRight size={15} />{t("projects.nextPage")}</button></nav>}
      <Modal open={createOpen} title={t("projects.new")} description={t("projects.newDescription")} onOpenChange={setCreateOpen} footer={<><button onClick={() => setCreateOpen(false)}>{t("common.cancel")}</button><button className="primary" onClick={() => void createProject()}>{t("common.create")}</button></>}>
        <label className="form-field">{t("projects.name")}<input autoFocus value={newProjectName} onChange={(event) => setNewProjectName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void createProject(); }} /></label>
      </Modal>
      <Modal open={importOpen} title={t("projects.upload")} description={t("projects.uploadDescription", { size: site.maxUploadSizeMB ?? 50 })} onOpenChange={(open) => { setImportOpen(open); if (!open) setImportError(""); }} footer={<><button onClick={() => { setImportOpen(false); setImportError(""); }}>{t("common.cancel")}</button><button className="primary" disabled={!importFile || importing} onClick={() => void importProject()}>{importing ? t("projects.importing") : t("projects.import")}</button></>}><div className="form-stack">{importError && <p className="error import-error">{importError}</p>}<div className={`upload-picker${importFile ? " has-file" : ""}`} onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; }} onDrop={(event) => { event.preventDefault(); selectImportFile(event.dataTransfer.files[0] ?? null); }}><input ref={importInput} className="sr-only" type="file" accept=".zip,application/zip" onChange={(event) => selectImportFile(event.target.files?.[0] ?? null)} /><FileArchive size={34} /><div className="upload-picker-copy"><strong>{importFile?.name ?? t("projects.chooseZip")}</strong><span>{importFile ? t("projects.selectedFileSize", { size: formatFileSize(importFile.size) }) : t("projects.dropZip")}</span></div><button type="button" onClick={() => importInput.current?.click()}><Upload size={15} />{t("projects.browse")}</button>{importFile && <button className="upload-clear" type="button" title={t("projects.clearFile")} aria-label={t("projects.clearFile")} onClick={() => { selectImportFile(null); if (importInput.current) importInput.current.value = ""; }}><X size={14} /></button>}</div><label className="form-field">{t("projects.name")}<input value={importName} onChange={(event) => setImportName(event.target.value)} /></label></div></Modal>
      <Modal open={tagCreateOpen} title={t("tags.create")} description={t("tags.createDescription")} onOpenChange={setTagCreateOpen} footer={<><button onClick={() => setTagCreateOpen(false)}>{t("common.cancel")}</button><button className="primary" onClick={() => void createTag()}>{t("common.create")}</button></>}><div className="form-stack"><label className="form-field">{t("tags.name")}<input autoFocus value={tagName} onChange={(event) => setTagName(event.target.value)} /></label><fieldset className="color-picker"><legend>{t("tags.color")}</legend>{colors.map((color) => <label key={color} className={tagColor === color ? "active" : ""}><input type="radio" name="dashboard-tag-color" checked={tagColor === color} onChange={() => setTagColor(color)} /><TagDot color={color} />{t(`tags.${color}`)}</label>)}</fieldset></div></Modal>
      <Modal open={Boolean(tagProject)} title={t("tags.assignTitle", { project: tagProject?.name ?? "" })} description={t("tags.assignDescription")} onOpenChange={(open) => { if (!open) setTagProject(null); }} footer={<button onClick={() => setTagProject(null)}>{t("common.close")}</button>}><div className="tag-assignment-list">{tags.map((tag) => <label key={tag.id}><input type="checkbox" checked={Boolean(tagProject?.tags.some((item) => item.id === tag.id))} onChange={() => void toggleProjectTag(tag)} /><TagDot color={tag.color} /><span>{tag.name}</span></label>)}{tags.length === 0 && <p className="muted">{t("tags.empty")}</p>}</div></Modal>
      <Modal open={Boolean(renameProject)} title={t("projects.renameTitle")} onOpenChange={(open) => { if (!open) setRenameProject(null); }} footer={<><button onClick={() => setRenameProject(null)}>{t("common.cancel")}</button><button className="primary" onClick={() => void rename()}>{t("projects.rename")}</button></>}><label className="form-field">{t("projects.name")}<input autoFocus value={renameValue} onChange={(event) => setRenameValue(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void rename(); }} /></label></Modal>
      <Modal open={Boolean(duplicateProject)} title={t("projects.duplicateTitle")} description={t("projects.duplicateDescription", { project: duplicateProject?.name ?? "" })} onOpenChange={(open) => { if (!open && !duplicating) { setDuplicateProject(null); setDuplicateValue(""); } }} footer={<><button disabled={duplicating} onClick={() => { setDuplicateProject(null); setDuplicateValue(""); }}>{t("common.cancel")}</button><button className="primary" disabled={duplicating || !duplicateValue.trim()} onClick={() => void duplicate()}>{duplicating ? t("projects.duplicating") : t("projects.duplicate")}</button></>}><label className="form-field">{t("projects.name")}<input autoFocus value={duplicateValue} onChange={(event) => setDuplicateValue(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void duplicate(); }} /></label></Modal>
      <Modal open={Boolean(transferProject)} title={t("projects.transferOwnership")} description={t("projects.transferDescription", { project: transferProject?.name ?? "" })} onOpenChange={(open) => { if (!open && !transferBusy) { setTransferProject(null); setTransferUserId(""); setTransferError(""); } }} footer={<><button disabled={transferBusy} onClick={() => { setTransferProject(null); setTransferUserId(""); setTransferError(""); }}>{t("common.cancel")}</button><button className="primary" disabled={transferBusy || !transferUserId} onClick={() => void transferOwnership()}>{transferBusy ? <LoaderCircle className="spin" size={14} /> : <ArrowRightLeft size={14} />}{t("projects.transfer")}</button></>}><div className="form-stack">{transferError && <p className="error dialog-error">{transferError}</p>}<label className="form-field">{t("projects.newOwner")}<select disabled={transferBusy || transferUsers.length === 0} value={transferUserId} onChange={(event) => setTransferUserId(event.target.value)}><option value="">{transferBusy ? t("common.loading") : transferUsers.length > 0 ? t("projects.chooseNewOwner") : t("projects.noTransferUsers")}</option>{transferUsers.map((candidate) => <option value={candidate.id} key={candidate.id}>{candidate.displayName ?? candidate.username} (@{candidate.username})</option>)}</select></label><p className="warning"><AlertTriangle size={15} />{t("projects.transferWarning")}</p></div></Modal>
      <ConfirmDialog open={Boolean(deleteProject)} title={t("projects.deleteTitle")} description={t("projects.deleteDescription", { project: deleteProject?.name ?? "" })} confirmLabel={t("common.delete")} danger onCancel={() => setDeleteProject(null)} onConfirm={() => void removeProject()} />
    </main>}{metricsOpen && <Suspense fallback={null}><SystemMetricsDialog open onOpenChange={setMetricsOpen} /></Suspense>}<SiteFooter />
  </div>;
}

function TagDot({ color }: { color: TagColor }) {
  return <span className={`tag-dot tag-${color}`} />;
}

function randomPassword(length = 10): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%";
  const values = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(values, (value) => alphabet[value % alphabet.length]).join("");
}

function AdminUsers({ currentUser }: { currentUser: User }) {
  const { t } = useTranslation();
  const [users, setUsers] = useState<User[]>([]);
  const [error, setError] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [createForm, setCreateForm] = useState({ username: "", displayName: "", password: "", role: "user" as "user" | "admin", canCreateProjects: false });
  const [resetTarget, setResetTarget] = useState<User | null>(null);
  const [resetValue, setResetValue] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<User | null>(null);
  const [deleteProjects, setDeleteProjects] = useState(false);
  const load = () => api<{ users: User[] }>("/api/admin/users").then(({ users }) => setUsers(users)).catch((e) => setError(errorMessage(e)));
  useEffect(() => { void load(); }, []);
  const create = async () => {
    if (createForm.password.length < MIN_PASSWORD_LENGTH) return setError(t("auth.passwordMinimum", { count: MIN_PASSWORD_LENGTH }));
    try {
      await api("/api/admin/users", { method: "POST", body: JSON.stringify({
        username: createForm.username,
        displayName: createForm.displayName || createForm.username,
        password: createForm.password,
        role: createForm.role,
        canCreateProjects: createForm.canCreateProjects
      }) });
      setCreateOpen(false); setCreateForm({ username: "", displayName: "", password: "", role: "user", canCreateProjects: false });
      await load();
    } catch (e) { setError(errorMessage(e)); }
  };
  const toggle = async (target: User) => {
    try {
      await api(`/api/admin/users/${target.id}`, { method: "PATCH", body: JSON.stringify({ disabled: !target.disabled }) });
      await load();
    } catch (e) { setError(errorMessage(e)); }
  };
  const toggleRole = async (target: User) => {
    try {
      await api(`/api/admin/users/${target.id}`, { method: "PATCH", body: JSON.stringify({ role: target.role === "admin" ? "user" : "admin" }) });
      await load();
    } catch (e) { setError(errorMessage(e)); }
  };
  const toggleProjectCreation = async (target: User) => {
    try {
      await api(`/api/admin/users/${target.id}`, { method: "PATCH", body: JSON.stringify({ canCreateProjects: !target.canCreateProjects }) });
      await load();
    } catch (e) { setError(errorMessage(e)); }
  };
  const resetPassword = async () => {
    if (!resetTarget || !resetValue) return;
    if (resetValue.length < MIN_PASSWORD_LENGTH) return setError(t("auth.passwordMinimum", { count: MIN_PASSWORD_LENGTH }));
    try {
      await api(`/api/admin/users/${resetTarget.id}`, { method: "PATCH", body: JSON.stringify({ password: resetValue }) });
      setResetTarget(null); setResetValue("");
    } catch (e) { setError(errorMessage(e)); }
  };
  const remove = async () => {
    if (!deleteTarget) return;
    try {
      await api(`/api/admin/users/${deleteTarget.id}`, { method: "DELETE", body: JSON.stringify({ deleteProjects }) });
      setDeleteTarget(null); setDeleteProjects(false);
      await load();
    } catch (e) { setError(errorMessage(e)); }
  };
  return <main className="dashboard">
    <div className="section-title"><div><h1><Users aria-hidden size={25} />{t("users.manage")}</h1><p className="muted">{t("users.onlyAdmin")}</p></div><button className="primary icon-button" onClick={() => setCreateOpen(true)}><UserPlus aria-hidden size={15} />{t("users.add")}</button></div>
    {error && <p className="error">{error}</p>}
    <div className="table-card"><table><thead><tr><th>{t("common.user")}</th><th>{t("users.role")}</th><th>{t("users.createProjects")}</th><th>{t("users.ownedProjects")}</th><th>{t("users.status")}</th><th>{t("users.actions")}</th></tr></thead>
      <tbody>{users.map((target) => <tr key={target.id}><td><strong>{target.displayName}</strong><small>@{target.username}</small></td><td>{target.role === "admin" ? t("common.admin") : t("common.user")}</td><td>{target.canCreateProjects ? t("users.allow") : t("users.deny")}</td><td>{target.ownedProjects}</td><td>{target.disabled ? t("common.disabled") : t("common.normal")}</td><td>
        <button disabled={target.id === currentUser.id} onClick={() => toggle(target)}>{target.disabled ? t("users.enable") : t("users.disable")}</button>
        <button disabled={target.id === currentUser.id} onClick={() => toggleRole(target)}>{target.role === "admin" ? t("users.demote") : t("users.promote")}</button>
        <button disabled={target.role === "admin"} onClick={() => toggleProjectCreation(target)}>{target.canCreateProjects ? t("users.denyCreate") : t("users.allowCreate")}</button>
        <button onClick={() => { setResetTarget(target); setResetValue(""); }}>{t("users.resetPassword")}</button>
        <button className="danger-text" disabled={target.id === currentUser.id} onClick={() => { setDeleteTarget(target); setDeleteProjects(false); }}>{t("common.delete")}</button>
      </td></tr>)}</tbody></table></div>
    <Modal open={createOpen} title={t("users.add")} description={t("users.addDescription")} onOpenChange={setCreateOpen} footer={<><button onClick={() => setCreateOpen(false)}>{t("common.cancel")}</button><button className="primary" disabled={createForm.password.length < MIN_PASSWORD_LENGTH} onClick={() => void create()}>{t("users.createUser")}</button></>}>
      <div className="form-stack"><label className="form-field">{t("auth.username")}<input value={createForm.username} onChange={(e) => setCreateForm({ ...createForm, username: e.target.value })} /></label><label className="form-field">{t("users.displayName")}<input value={createForm.displayName} onChange={(e) => setCreateForm({ ...createForm, displayName: e.target.value })} /></label><label className="form-field">{t("users.initialPassword")}<span className="password-generator"><input minLength={MIN_PASSWORD_LENGTH} autoComplete="new-password" value={createForm.password} onChange={(e) => setCreateForm({ ...createForm, password: e.target.value })} /><button type="button" title={t("users.generatePassword")} onClick={() => setCreateForm({ ...createForm, password: randomPassword() })}><Dices size={15} />{t("users.randomPassword")}</button></span><small className="field-hint">{t("auth.passwordMinimum", { count: MIN_PASSWORD_LENGTH })}</small></label><label className="form-field">{t("users.role")}<select value={createForm.role} onChange={(e) => setCreateForm({ ...createForm, role: e.target.value as "user" | "admin" })}><option value="user">{t("common.user")}</option><option value="admin">{t("common.admin")}</option></select></label><label className="checkbox-field"><input type="checkbox" checked={createForm.canCreateProjects || createForm.role === "admin"} disabled={createForm.role === "admin"} onChange={(e) => setCreateForm({ ...createForm, canCreateProjects: e.target.checked })} /> {t("users.allowCreate")}</label></div>
    </Modal>
    <Modal open={Boolean(resetTarget)} title={t("users.resetPassword")} description={t("users.resetDescription", { username: resetTarget?.username ?? "" })} onOpenChange={(open) => { if (!open) setResetTarget(null); }} footer={<><button onClick={() => setResetTarget(null)}>{t("common.cancel")}</button><button className="primary" disabled={resetValue.length < MIN_PASSWORD_LENGTH} onClick={() => void resetPassword()}>{t("users.reset")}</button></>}>
      <label className="form-field">{t("auth.newPassword")}<input autoFocus type="password" minLength={MIN_PASSWORD_LENGTH} autoComplete="new-password" value={resetValue} onChange={(e) => setResetValue(e.target.value)} /><small className="field-hint">{t("auth.passwordMinimum", { count: MIN_PASSWORD_LENGTH })}</small></label>
    </Modal>
    <Modal open={Boolean(deleteTarget)} title={t("users.deleteTitle")} description={t("users.deleteDescription", { username: deleteTarget?.username ?? "" })} onOpenChange={(open) => { if (!open) setDeleteTarget(null); }} footer={<><button onClick={() => setDeleteTarget(null)}>{t("common.cancel")}</button><button className="danger" onClick={() => void remove()}>{t("users.deleteTitle")}</button></>}>
      <fieldset className="choice-group"><legend>{t("users.ownedChoice", { count: deleteTarget?.ownedProjects ?? 0 })}</legend><label><input type="radio" checked={!deleteProjects} onChange={() => setDeleteProjects(false)} /> {t("users.transferProjects")}</label><label><input type="radio" checked={deleteProjects} onChange={() => setDeleteProjects(true)} /> {t("users.deleteProjects")}</label></fieldset>
    </Modal>
  </main>;
}

type PreviewTab = "pdf" | "log" | "warnings" | "errors" | "artifacts" | "clean";
type PreviewSurface = "pdf" | "diagnostics";
type DiagnosticTab = Exclude<PreviewTab, "pdf">;
interface ProjectOutlineItem { path: string; line: number; level: number; title: string }
interface LoadOptions { signal?: AbortSignal; isCurrent?: () => boolean }

function ProjectWorkspace({ site, user, projectId, onBack }: {
  site: SiteConfig; user: User; projectId: string; onBack: () => void;
}) {
  const { t } = useTranslation();
  const [project, setProject] = useState<Project | null>(null);
  const [collaborationReady, setCollaborationReady] = useState(false);
  const [dictionaryWords, setDictionaryWords] = useState<string[]>([]);
  const [completionIndex, setCompletionIndex] = useState<LatexCompletionIndex | null>(null);
  const [projectOutline, setProjectOutline] = useState<ProjectOutlineItem[]>([]);
  const [activeFile, setActiveFile] = useState("");
  const [activeMainFile, setActiveMainFile] = useState("");
  const [rootDocuments, setRootDocuments] = useState<Set<string>>(new Set());
  const [content, setContent] = useState("");
  const [loadedFile, setLoadedFile] = useState("");
  const [dirty, setDirty] = useState(false);
  const [saveState, setSaveState] = useState("editor.saved");
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null);
  const lastSavedAtRef = useRef(lastSavedAt);
  lastSavedAtRef.current = lastSavedAt;
  const [sourceCursor, setSourceCursor] = useState({ line: 1, column: 1 });
  const sourceCursorRef = useRef(sourceCursor);
  const [previewTab, setPreviewTab] = useState<PreviewSurface>("pdf");
  const [diagnosticTab, setDiagnosticTab] = useState<DiagnosticTab>("log");
  const selectPreviewTab = (next: PreviewTab): void => {
    if (next === "pdf") {
      setPreviewTab("pdf");
      return;
    }
    setDiagnosticTab(next);
    setPreviewTab("diagnostics");
  };
  const { workspaceLayout, setWorkspaceLayout } = useWorkspaceLayout(user.id, projectId);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [selection, setSelectionState] = useState<SourceSelection>({ selectedText: "", startOffset: 0, endOffset: 0 });
  const selectionRef = useRef<SourceSelection>({ selectedText: "", startOffset: 0, endOffset: 0 });
  const setSelection = (next: SourceSelection): void => {
    selectionRef.current = next;
    setSelectionState(next);
  };
  const [sidePanel, setSidePanel] = useState<"comments" | "settings" | null>(null);
  const [filesCollapsed, setFilesCollapsed] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [gitOpen, setGitOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [cleanMode, setCleanMode] = useState<CompileCleanMode | null>(null);
  const [quickOpen, setQuickOpen] = useState(false);
  const [projectSearchOpen, setProjectSearchOpen] = useState(false);
  const [formatting, setFormatting] = useState(false);
  const [editorPreferences, setEditorPreferences] = useState<EditorPreferences>(() => loadEditorPreferences(user.id, projectId));
  const [openTabs, setOpenTabs] = useState<string[]>([]);
  const openTabsRef = useRef<string[]>([]);
  openTabsRef.current = openTabs;
  const uploadInput = useRef<HTMLInputElement>(null);
  const filesPanel = useRef<ImperativePanelHandle>(null);
  const localEditSequence = useRef(0);
  const persistedEditSequence = useRef(0);
  const contentRef = useRef("");
  const activeFileRef = useRef("");
  const activeMainFileRef = useRef("");
  const rootDetectionFile = useRef("");
  const projectLoadSequence = useRef(0);
  const completionRequest = useRef<AbortController | null>(null);
  const outlineRequest = useRef<AbortController | null>(null);
  const dictionaryRequest = useRef<AbortController | null>(null);
  const refreshRequest = useRef<AbortController | null>(null);
  const formattingRef = useRef(false);
  const formattingTaskRef = useRef<Promise<void> | null>(null);
  const onBackRef = useRef(onBack);
  onBackRef.current = onBack;
  activeMainFileRef.current = activeMainFile;

  const updateSourceCursor = (line: number, column: number) => {
    const next = { line, column };
    sourceCursorRef.current = next;
    setSourceCursor(next);
  };

  const updateOpenTabs = (updater: (current: string[]) => string[]) => {
    const current = openTabsRef.current;
    const next = updater(current);
    if (next === current) return;
    openTabsRef.current = next;
    setOpenTabs(next);
  };

  useEffect(() => {
    // ProjectWorkspace can stay mounted while the route changes. Never carry
    // tabs from the previous project into the new file tree.
    openTabsRef.current = [];
    setOpenTabs([]);
  }, [projectId]);

  const closeTab = (tabPath: string) => {
    const current = openTabsRef.current;
    const index = current.indexOf(tabPath);
    if (index < 0) return;
    const nextTabs = current.filter((p) => p !== tabPath);
    openTabsRef.current = nextTabs;
    setOpenTabs(nextTabs);
    if (activeFileRef.current !== tabPath) return;
    const nextActive = nextTabs.length > 0
      ? nextTabs[Math.min(index, nextTabs.length - 1)]
      : project?.mainFile ?? "";
    setActiveFile(nextActive);
  };

  const {
    collaboration,
    status: collaborationStatus,
    synced: collaborationSynced,
    activeSessions,
    compileState,
    setCompileState,
    filesEvent,
    commentsRevision,
    dictionaryRevision,
    localDraftReady,
    permission: collaborationPermission,
    reconnect: reconnectCollaboration
  } = useProjectCollaboration(projectId, user, activeMainFile, project?.permission ?? "read", collaborationReady, () => setSaveState("editor.offlineDraft"));

  const {
    pdfTarget, pdfViewport, sourceJump, setPdfViewport, clearPdfViewport,
    jumpToSource, syncSourceToPdf, syncPdfToSource, syncVisiblePdfToSource
  } = useSyncTeX({
    projectId,
    mainFile: activeMainFile,
    activeFile,
    onActiveFile: setActiveFile,
    onError: setError,
    onShowPdf: () => selectPreviewTab("pdf")
  });

  const spellCheck = useSpellCheck({
    active: Boolean(project && activeFile && collaborationSynced && editorPreferences.spellCheck),
    activeFile,
    content,
    dictionaryWords
  });

  useEffect(() => {
    setEditorPreferences(loadEditorPreferences(user.id, projectId));
  }, [user.id, projectId]);

  const updateEditorContent = (next: string) => {
    contentRef.current = next;
    setContent(next);
  };

  useEffect(() => {
    activeFileRef.current = activeFile;
    sourceCursorRef.current = { line: 1, column: 1 };
    setSourceCursor({ line: 1, column: 1 });
    setSelection({ selectedText: "", startOffset: 0, endOffset: 0 });
    if (!editorPreferences.openFilesInTabs) {
      if (openTabsRef.current.length > 0) {
        openTabsRef.current = [];
        setOpenTabs([]);
      }
      return;
    }
    if (activeFile) {
      updateOpenTabs((current) => current.includes(activeFile) ? current : [...current, activeFile]);
    }
  }, [activeFile, editorPreferences.openFilesInTabs, projectId]);

  useEffect(() => {
    if (!dirty) return;
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnBeforeUnload);
    return () => window.removeEventListener("beforeunload", warnBeforeUnload);
  }, [dirty]);

  useEffect(() => {
    if (collaborationStatus !== "disconnected") return;
    const controller = new AbortController();
    void api<{ project: Project }>(`/api/projects/${projectId}`, { signal: controller.signal })
      .then(({ project: currentProject }) => {
        if (!controller.signal.aborted) {
          setProject(currentProject);
          setError("");
        }
      })
      .catch((error) => {
        if (isAbortError(error)) return;
        if (error instanceof ApiError && [401, 403, 404].includes(error.status)) {
          setError(errorMessage(error));
          onBackRef.current();
          return;
        }
        setError(t("errors.collaborationUnavailable"));
      });
    return () => controller.abort();
  }, [collaborationStatus, projectId, t]);

  const loadCompletionIndex = async (options: LoadOptions = {}) => {
    completionRequest.current?.abort();
    completionRequest.current = null;
    const controller = options.signal ? null : new AbortController();
    if (controller) completionRequest.current = controller;
    try {
      const result = await api<{ index: LatexCompletionIndex }>(`/api/projects/${projectId}/completions`, { signal: options.signal ?? controller?.signal });
      if (!options.isCurrent || options.isCurrent()) setCompletionIndex(result.index);
    } catch (error) {
      if (isAbortError(error)) return;
      if (!options.isCurrent || options.isCurrent()) setCompletionIndex(null);
    } finally {
      if (controller && completionRequest.current === controller) completionRequest.current = null;
    }
  };
  const loadProjectOutline = async (options: LoadOptions = {}, mainFile = activeMainFileRef.current) => {
    outlineRequest.current?.abort();
    outlineRequest.current = null;
    const controller = options.signal ? null : new AbortController();
    if (controller) outlineRequest.current = controller;
    try {
      const query = mainFile ? `?mainFile=${encodeURIComponent(mainFile)}` : "";
      const result = await api<{ outline: ProjectOutlineItem[] }>(`/api/projects/${projectId}/outline${query}`, { signal: options.signal ?? controller?.signal });
      if (!options.isCurrent || options.isCurrent()) setProjectOutline(result.outline);
    } catch (error) {
      if (!isAbortError(error) && (!options.isCurrent || options.isCurrent())) setProjectOutline([]);
    } finally {
      if (controller && outlineRequest.current === controller) outlineRequest.current = null;
    }
  };
  const loadDictionary = async (options: LoadOptions = {}) => {
    dictionaryRequest.current?.abort();
    dictionaryRequest.current = null;
    const controller = options.signal ? null : new AbortController();
    if (controller) dictionaryRequest.current = controller;
    try {
      const result = await api<{ words: string[] }>(`/api/projects/${projectId}/dictionary`, { signal: options.signal ?? controller?.signal });
      if (!options.isCurrent || options.isCurrent()) setDictionaryWords(result.words);
    } catch (error) {
      if (isAbortError(error)) return;
      if (!options.isCurrent || options.isCurrent()) setDictionaryWords([]);
    } finally {
      if (controller && dictionaryRequest.current === controller) dictionaryRequest.current = null;
    }
  };
  useEffect(() => {
    let cancelled = false;
    const sequence = ++projectLoadSequence.current;
    const controller = new AbortController();
    const isCurrent = () => !cancelled && projectLoadSequence.current === sequence;
    let projectLoaded = false;
    rootDetectionFile.current = "";
    setProject(null); setFiles([]); setProjectOutline([]); setActiveFile(""); setActiveMainFile(""); setRootDocuments(new Set()); setContent(""); setLoadedFile(""); setCompileState(null);
    clearPdfViewport(); setCompletionIndex(null); setDictionaryWords([]);
    void loadPdfPreview();
    const projectRequest = api<{ project: Project }>(`/api/projects/${projectId}`, { signal: controller.signal }).then((result) => {
      if (!isCurrent()) return;
      projectLoaded = true;
      setProject(result.project);
      setActiveFile(result.project.mainFile);
      setActiveMainFile(result.project.mainFile);
      setRootDocuments(new Set([result.project.mainFile]));
      setExpandedFolders(new Set(parentFolders(result.project.mainFile)));
    }).catch((e) => { if (isCurrent()) setError(errorMessage(e)); });
    const filesLoadRequest = api<{ files: FileEntry[] }>(`/api/projects/${projectId}/files`, { signal: controller.signal })
      .then((result) => { if (isCurrent()) setFiles(result.files); })
      .catch((e) => { if (isCurrent()) setError(errorMessage(e)); });
    let deferredTimer: number | null = null;
    void Promise.allSettled([projectRequest, filesLoadRequest]).then(() => {
      if (!isCurrent() || !projectLoaded) return;
      // Completion indexing reads the whole project. Let the critical editor
      // and retained-PDF requests finish and paint before starting these.
      deferredTimer = window.setTimeout(() => {
        if (!isCurrent()) return;
        void Promise.all([
          loadCompletionIndex({ signal: controller.signal, isCurrent }),
          loadDictionary({ signal: controller.signal, isCurrent })
        ]);
      }, 0);
    });
    return () => {
      cancelled = true;
      if (deferredTimer !== null) window.clearTimeout(deferredTimer);
      controller.abort();
      completionRequest.current?.abort(); completionRequest.current = null;
      outlineRequest.current?.abort(); outlineRequest.current = null;
      dictionaryRequest.current?.abort(); dictionaryRequest.current = null;
      refreshRequest.current?.abort(); refreshRequest.current = null;
    };
  }, [projectId]);

  useEffect(() => {
    if (dictionaryRevision) void loadDictionary();
  }, [dictionaryRevision, projectId]);

  useEffect(() => {
    if (!project || collaborationStatus !== "connected" || collaborationPermission === project.permission) return;
    // A server-side member update can change an already-open editor from edit
    // to read-only without waiting for the next API request.
    setProject((current) => current ? { ...current, permission: collaborationPermission } : current);
  }, [collaborationPermission, project?.permission]);

  useEffect(() => {
    if (!filesEvent) return;
    const deletedActiveFile = filesEvent.kind === "delete" && Boolean(filesEvent.path)
      && pathContains(filesEvent.path!, activeFileRef.current);
    const deletedCompileTarget = filesEvent.kind === "delete" && Boolean(filesEvent.path)
      && pathContains(filesEvent.path!, activeMainFileRef.current);
    if (filesEvent.kind === "move" && filesEvent.source && filesEvent.destination) {
      const source = filesEvent.source;
      const destination = filesEvent.destination;
      const remap = (value: string) => value === source
        ? destination
        : value.startsWith(`${source}/`) ? `${destination}${value.slice(source.length)}` : value;
      setActiveFile((current) => remap(current));
      setActiveMainFile((current) => remap(current));
      setRootDocuments((current) => new Set([...current].map(remap)));
      setSelectedFolder((current) => current ? remap(current) : current);
      updateOpenTabs((current) => current.map(remap));
    }
    if (deletedActiveFile) {
      setActiveFile("");
      setLoadedFile("");
      updateEditorContent("");
      setNotice(t("editor.fileDeletedByCollaborator", { path: filesEvent.path }));
    }
    if (filesEvent.kind === "delete" && filesEvent.path) {
      setRootDocuments((current) => new Set([...current].filter((filePath) => !pathContains(filesEvent.path!, filePath))));
      setSelectedFolder((current) => pathContains(filesEvent.path!, current) ? "" : current);
      setResourcePreview((current) => current && pathContains(filesEvent.path!, current.path) ? null : current);
      updateOpenTabs((current) => current.filter((filePath) => !pathContains(filesEvent.path!, filePath)));
    }
    refreshRequest.current?.abort();
    const controller = new AbortController();
    refreshRequest.current = controller;
    void Promise.all([
      loadFiles({ signal: controller.signal }),
      api<{ project: Project }>(`/api/projects/${projectId}`, { signal: controller.signal })
    ]).then(([nextFiles, projectResult]) => {
      setProject(projectResult.project);
      if (deletedCompileTarget) setActiveMainFile(projectResult.project.mainFile);
      if (deletedActiveFile && nextFiles) {
        const fallback = nextFiles.find((entry) => entry.type === "file" && entry.path === projectResult.project.mainFile)
          ?? nextFiles.find((entry) => entry.type === "file" && isEditableTextFile(entry.path));
        setActiveFile(fallback?.path ?? "");
      }
      void loadCompletionIndex({ signal: controller.signal });
      void loadProjectOutline({ signal: controller.signal }, deletedCompileTarget ? projectResult.project.mainFile : activeMainFileRef.current);
    }).catch((error) => { if (!isAbortError(error)) return; })
      .finally(() => { if (refreshRequest.current === controller) refreshRequest.current = null; });
  }, [filesEvent?.revision]);

  useEffect(() => {
    collaboration.setActiveFile(activeFile);
    if (!activeFile) return;
    setLoadedFile(""); setSaveState("editor.loading");
    const sharedText = collaboration.getText(activeFile);
    const updateContent = (_event?: unknown, transaction?: { local: boolean }) => {
      updateEditorContent(sharedText.toString());
      setLoadedFile(activeFile);
      if (transaction?.local && project?.permission !== "read") {
        localEditSequence.current += 1;
        setDirty(true);
        setSaveState("editor.pending");
      } else if (localEditSequence.current <= persistedEditSequence.current) {
        setSaveState(lastSavedAtRef.current ? "editor.savedAt" : "editor.saved");
      }
    };
    sharedText.observe(updateContent);
    if (collaborationSynced || localDraftReady) updateContent();
    return () => {
      sharedText.unobserve(updateContent);
    };
  }, [activeFile, collaboration, collaborationSynced, localDraftReady, project?.permission]);

  useEffect(() => {
    if (!activeFile || loadedFile !== activeFile || rootDetectionFile.current === activeFile) return;
    rootDetectionFile.current = activeFile;
    if (!activeFile.toLocaleLowerCase().endsWith(".tex") || !hasDocumentClass(content)) return;
    setRootDocuments((current) => new Set([...current, activeFile]));
    setActiveMainFile(activeFile);
  }, [activeFile, loadedFile, content]);

  const persistPendingEdits = async (): Promise<CollaborationSaveReceipt> => {
    if (!collaborationSynced) throw new Error("Collaboration is not synchronized");
    const sequence = localEditSequence.current;
    const receipt = await collaboration.flush();
    persistedEditSequence.current = Math.max(persistedEditSequence.current, sequence);
    setLastSavedAt(receipt.persistedAt);
    if (/\.tex$/i.test(activeFileRef.current)) void loadProjectOutline();
    if (localEditSequence.current === sequence) {
      setDirty(false);
      setSaveState("editor.savedAt");
    } else {
      setSaveState("editor.pending");
    }
    return receipt;
  };

  useEffect(() => {
    if (!dirty || !activeFile) return;
    if (!collaborationSynced) {
      setSaveState("editor.offlineDraft");
      return;
    }
    setSaveState("editor.pending");
    const timer = window.setTimeout(() => {
      setSaveState("editor.saving");
      void persistPendingEdits().catch(() => {
        setSaveState(collaboration.connected ? "editor.saveFailed" : "editor.offlineDraft");
      });
    }, 750);
    return () => window.clearTimeout(timer);
  }, [content, dirty, activeFile, collaborationSynced]);

  const save = async (): Promise<boolean> => {
    if (!project || project.permission === "read" || !collaborationSynced || !activeFile) return false;
    setSaveState("editor.saving");
    try {
      await persistPendingEdits();
      void loadCompletionIndex();
      return true;
    } catch (saveError) {
      setSaveState("editor.saveFailed");
      setError(errorMessage(saveError) || t("errors.collaborationUnavailable"));
      return false;
    }
  };
  const formatWithHostFormatter = async (filePath: string, source: string): Promise<string> => {
    const result = await api<{ formatter: "tex-fmt"; formatted: string }>(
      `/api/projects/${projectId}/format`,
      { method: "POST", body: JSON.stringify({ path: filePath, source }) }
    );
    return result.formatted;
  };
  const formatBeforeCompile = async (): Promise<void> => {
    if (!editorPreferences.formatOnCompile || !project || project.permission === "read"
      || !collaborationSynced || !isFormattableLatexFile(activeFileRef.current) || formattingRef.current) return;
    const filePath = activeFileRef.current;
    const sharedText = collaboration.getText(filePath);
    const source = sharedText.toString();
    formattingRef.current = true;
    setFormatting(true);
    try {
      const formatted = await formatWithHostFormatter(filePath, source);
      const edits = await createLatexTextEdits(source, formatted);
      if (activeFileRef.current !== filePath || sharedText.toString() !== source) {
        throw new Error(t("editor.formatSourceChanged"));
      }
      if (edits.length) collaboration.applyTextEdits(filePath, edits);
    } catch (formatError) {
      setError(t("editor.formatFailedContinue", { message: errorMessage(formatError) }));
    } finally {
      formattingRef.current = false;
      setFormatting(false);
    }
  };
  const saveForCompile = async (): Promise<boolean> => {
    if (formattingTaskRef.current) await formattingTaskRef.current;
    await formatBeforeCompile();
    return save();
  };
  const formatSelectedSource = async (): Promise<void> => {
    if (!project || project.permission === "read" || !collaborationSynced || formattingRef.current
      || !isFormattableLatexFile(activeFileRef.current)) return;
    const currentSelection = selectionRef.current;
    if (!currentSelection.selectedText.trim()) {
      setNotice(t("editor.formatSelectionRequired"));
      return;
    }
    const filePath = activeFileRef.current;
    const { startOffset, endOffset, selectedText } = currentSelection;
    const sharedText = collaboration.getText(filePath);
    if (sharedText.toString().slice(startOffset, endOffset) !== selectedText) {
      setError(t("editor.formatSelectionChanged"));
      return;
    }
    formattingRef.current = true;
    setFormatting(true);
    let finishFormattingTask: () => void = () => {};
    const formattingTask = new Promise<void>((resolve) => { finishFormattingTask = resolve; });
    formattingTaskRef.current = formattingTask;
    try {
      const formatted = reindentLatexSelection(selectedText, await formatWithHostFormatter(filePath, selectedText));
      const edits = await createLatexTextEdits(selectedText, formatted, startOffset);
      if (activeFileRef.current !== filePath || sharedText.toString().slice(startOffset, endOffset) !== selectedText) {
        setError(t("editor.formatSelectionChanged"));
        return;
      }
      if (edits.length) collaboration.applyTextEdits(filePath, edits);
      setError("");
      setNotice(t("editor.formatSelectionComplete"));
    } catch (formatError) {
      setError(t("editor.formatFailed", { message: errorMessage(formatError) }));
    } finally {
      formattingRef.current = false;
      setFormatting(false);
      finishFormattingTask();
      if (formattingTaskRef.current === formattingTask) formattingTaskRef.current = null;
    }
  };
  const {
    files, setFiles, loadFiles,
    newFileOpen, setNewFileOpen, newFilePath, setNewFilePath,
    resourcePreview, setResourcePreview, resourcePreviewLoading, setResourcePreviewLoading,
    newFolderOpen, setNewFolderOpen, newFolderName, setNewFolderName,
    fileDialogError, setFileDialogError,
    selectedFolder, setSelectedFolder,
    expandedFolders, setExpandedFolders,
    moveEntry, setMoveEntry, moveDestination, setMoveDestination,
    deleteEntry, setDeleteEntry,
    fileDragActive, setFileDragActive,
    uploadConflict, setUploadConflict, uploadingFiles,
    directoryEntries, visibleEntries,
    createFile, createFolder, uploadFiles, upload, openFile, movePath, removePath
  } = useProjectFiles({
    projectId,
    site,
    activeFile,
    dirty,
    save,
    onError: setError,
    onProject: setProject,
    onActiveFile: setActiveFile,
    onActiveMainFile: setActiveMainFile,
    onRootDocuments: setRootDocuments
  });

  useEffect(() => {
    if (!editorPreferences.openFilesInTabs || files.length === 0) return;
    const existingFiles = new Set(files.filter((entry) => entry.type === "file" && isEditableTextFile(entry.path)).map((entry) => entry.path));
    updateOpenTabs((current) => {
      const next = current.filter((filePath) => existingFiles.has(filePath));
      return next.length === current.length ? current : next;
    });
  }, [files, editorPreferences.openFilesInTabs]);
  const {
    comments, focusComment, setFocusComment, commentOpen, setCommentOpen, commentText, setCommentText,
    addComment, toggleComment, replyToComment, editComment, deleteComment, editCommentReply, deleteCommentReply
  } = useProjectComments({
    projectId,
    activeFile,
    permission: project?.permission,
    revision: commentsRevision,
    selection,
    save,
    onError: setError,
    onAdded: () => setSidePanel("comments")
  });
  const {
    pdfUrl, pdfCompiledAt, pdfLoading, compileLog, compileDiagnostics, compileOutcome,
    artifacts, artifactPreview, artifactLoading, editorNotice, localCompiling, cleaning,
    compile, cleanCompile, viewArtifact
  } = useProjectCompilation({
    projectId,
    project,
    mainFile: activeMainFile,
    collaborationSynced,
    sharedState: compileState,
    onSharedState: setCompileState,
    save: saveForCompile,
    loadOutline: (signal, mainFile) => loadProjectOutline({ signal }, mainFile),
    onPreviewTab: selectPreviewTab,
    onError: setError,
    onCompileStart: () => { setError(""); setNotice(""); },
    onCompileSuccess: () => {
      const path = activeFileRef.current;
      if (path) void syncSourceToPdf(path, sourceCursorRef.current.line, sourceCursorRef.current.column, { silent: true });
    },
    onPdfChanged: clearPdfViewport
  });
  useEffect(() => {
    // Let the latest-PDF response render PdfPreview first. Its PDF request is
    // the critical path; only then should a cold Yjs room be reconstructed.
    if (!project || !activeMainFile || (!pdfUrl && pdfLoading)) return;
    // Give the browser a short scheduling head start for the PDF fetch before
    // opening the WebSocket that may trigger a cold room reconstruction.
    const timer = window.setTimeout(() => setCollaborationReady(true), pdfUrl ? 150 : 0);
    return () => window.clearTimeout(timer);
  }, [project, pdfLoading, pdfUrl]);
  useEffect(() => {
    const openNavigation = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      if (!event.shiftKey && event.key.toLocaleLowerCase() === "p") {
        event.preventDefault(); setQuickOpen(true);
      } else if (event.shiftKey && event.key.toLocaleLowerCase() === "f") {
        event.preventDefault(); setProjectSearchOpen(true);
      }
    };
    window.addEventListener("keydown", openNavigation, true);
    return () => window.removeEventListener("keydown", openNavigation, true);
  }, []);
  const updateEditorPreferences = (next: EditorPreferences) => {
    setEditorPreferences(next); saveEditorPreferences(user.id, projectId, next);
  };
  const toggleFilesPanel = () => {
    if (filesPanel.current?.isCollapsed()) filesPanel.current.expand();
    else filesPanel.current?.collapse();
  };
  const outline = useMemo(() => projectOutline.length
    ? projectOutline
    : parseOutline(content).map((item) => ({ ...item, path: activeFile })), [projectOutline, content, activeFile]);
  const compileMessages = useMemo(() => classifyCompileLog(compileLog, compileOutcome), [compileLog, compileOutcome]);
  const showEditor = workspaceLayout !== "pdf-only";
  const showPreview = workspaceLayout !== "editor-only";
  const changeWorkspaceLayout = (next: WorkspaceLayout) => {
    setWorkspaceLayout(next);
    if (next === "pdf-only") selectPreviewTab("pdf");
  };
  const deleteActiveSessions = deleteEntry
    ? activeSessions.filter((session) => session.filePath && pathContains(deleteEntry.path, session.filePath))
    : [];
  if (!project) return <div className="center-card"><p>{error || t("common.loading")}</p>{error && <button className="primary" onClick={onBack}>{t("editor.backToProjects")}</button>}</div>;
  const readOnly = project.permission === "read" || !collaborationSynced;
  const replaceSpellCheckIssue = (issue: SpellCheckIssue, replacement: string): void => {
    if (readOnly) return;
    const filePath = activeFileRef.current;
    if (!filePath) return;
    const sharedText = collaboration.getText(filePath);
    const source = sharedText.toString();
    if (source.slice(issue.from, issue.to) !== issue.word) {
      setError(t("editor.spellCheckSourceChanged"));
      return;
    }
    try {
      collaboration.applyTextEdits(filePath, [{ from: issue.from, to: issue.to, replacement }]);
    } catch (replaceError) {
      setError(errorMessage(replaceError));
    }
  };
  const sharedCompiling = compileState?.mainFile === activeMainFile
    && (compileState.status === "queued" || compileState.status === "running");
  const compileBusy = localCompiling || sharedCompiling || cleaning;
  const collaborativeText = activeFile ? collaboration.getText(activeFile) : null;
  const pdfCompiledLabel = pdfCompiledAt ? new Date(pdfCompiledAt).toLocaleString(i18n.resolvedLanguage, {
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit"
  }) : "";
  const pdfTargetLabel = activeMainFile.split("/").at(-1) ?? activeMainFile;
  const diagnosticCount = compileMessages.warnings.length + compileMessages.errors.length + artifacts.length;
  const pdfDownloadUrl = pdfUrl ? `${pdfUrl}${pdfUrl.includes("?") ? "&" : "?"}download=1` : "";
  const syncMainFile = activeMainFile || project.mainFile;
  const canSyncWithPdf = Boolean(activeFile && activeFile === syncMainFile && /\.tex$/i.test(activeFile));
  const activateTab = (tabPath: string): void => {
    const entry = files.find((file) => file.path === tabPath);
    if (entry && isEditableTextFile(entry.path)) openFile(entry);
    else closeTab(tabPath);
  };
  const focusTab = (tabPath: string): void => {
    document.getElementById(`editor-tab-${encodeURIComponent(tabPath)}`)?.focus();
  };
  const handleTabKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number): void => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const nextIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? openTabs.length - 1
        : (index + (event.key === "ArrowLeft" ? -1 : 1) + openTabs.length) % openTabs.length;
    const nextPath = openTabs[nextIndex];
    if (!nextPath) return;
    activateTab(nextPath);
    window.requestAnimationFrame(() => focusTab(nextPath));
  };
  const compileStatusMessage = compileBusy
    ? sharedCompiling
      ? compileState?.status === "queued" ? t("editor.compileQueued") : t("editor.compilingBy", { name: compileState?.requestedBy.name ?? t("common.user") })
      : t("editor.compiling")
    : compileOutcome === "failed"
      ? pdfUrl && pdfCompiledAt
        ? t("editor.compileFailedRetained", { time: new Date(pdfCompiledAt).toLocaleString(i18n.resolvedLanguage) })
        : t("editor.compileFailedNoPdf")
      : "";
  const saveStateLabel = saveState === "editor.savedAt" && lastSavedAt
    ? t("editor.savedAt", { time: new Date(lastSavedAt).toLocaleTimeString(i18n.resolvedLanguage, { hour: "2-digit", minute: "2-digit", second: "2-digit" }) })
    : t(saveState);

  return <div className="workspace">
    <header className="editor-topbar">
      <button className="back" title={t("editor.backToProjects")} aria-label={t("editor.backToProjects")} onClick={onBack}><ArrowLeft size={18} /></button><SiteLogo siteName={site.siteName} compact />
      <div className="project-heading"><strong>{project.name}</strong><small>{activeFile} · {saveStateLabel}</small></div>
      {editorPreferences.vimMode && <span className="vim-status-badge" title={t("editor.vimOnHint")}><Keyboard size={14} />{t("editor.vimOn")}</span>}
      <CollaborationPresence sessions={activeSessions} status={collaborationStatus} />
      {collaborationStatus === "disconnected" && <div className="collaboration-recovery" role="status"><span>{t("editor.collaboration.disconnected")}</span><button type="button" onClick={reconnectCollaboration}>{t("editor.collaboration.reconnect")}</button></div>}
      <div className="editor-actions">{showEditor && <button className={!filesCollapsed ? "active" : ""} onClick={toggleFilesPanel}>{filesCollapsed ? <PanelLeftOpen size={15} /> : <PanelLeftClose size={15} />}{t("common.files")}</button>}<WorkspaceLayoutMenu value={workspaceLayout} onChange={changeWorkspaceLayout} /><button onClick={() => setHistoryOpen(true)}><History size={15} />{t("history.title")}</button><button onClick={() => setShareOpen(true)}><Users size={15} />{t("projectSettings.share")}</button>{project.ownerId === user.id && <button onClick={() => setGitOpen(true)}><GitBranch size={15} />Git</button>}{showEditor && project.permission !== "read" && isFormattableLatexFile(activeFile) && <button title={selection.selectedText.trim() ? t("editor.formatSelection") : t("editor.formatSelectionHint")} onMouseDown={(event) => event.preventDefault()} onClick={() => void formatSelectedSource()} disabled={readOnly || formatting || !collaborationSynced}>{formatting ? <LoaderCircle className="spin" size={15} /> : <AlignLeft size={15} />}{formatting ? t("editor.formatting") : t("editor.formatSelection")}</button>}<button onClick={() => setCommentOpen(true)} disabled={!activeFile}><MessageSquarePlus size={15} />{t("editor.addComment")}</button><button className={sidePanel === "comments" ? "active" : ""} onClick={() => setSidePanel(sidePanel === "comments" ? null : "comments")}><MessageSquare size={15} />{t("common.comments")} {comments.filter((item) => !item.resolved).length || ""}</button><button className={sidePanel === "settings" ? "active" : ""} onClick={() => setSidePanel(sidePanel === "settings" ? null : "settings")}><Settings size={15} />{t("common.settings")}</button><button className="compile" title={sharedCompiling ? t("editor.compilingBy", { name: compileState?.requestedBy.name ?? "" }) : t("editor.compileShortcut")} onClick={compile} disabled={compileBusy || formatting || readOnly || !collaborationSynced}>{compileBusy ? <LoaderCircle className="spin" size={15} /> : <Play size={15} />}{sharedCompiling ? t("editor.compilingBy", { name: compileState?.requestedBy.name ?? "" }) : localCompiling ? t("editor.compiling") : t("editor.compile", { engine: project.engine })}</button></div>
    </header>
    {compileStatusMessage && <div className={`compile-status-strip${compileOutcome === "failed" ? " failed" : ""}`} role="status" aria-live="polite"><LoaderCircle className={compileBusy ? "spin" : ""} size={14} /><span>{compileStatusMessage}</span></div>}
    {error && <div className="toast" onClick={() => setError("")}>{error}</div>}
    {notice && <div className="toast success" onClick={() => setNotice("")}>{notice}</div>}
    <PanelGroup autoSaveId="texlite-workspace-layout" direction="horizontal" className="work-grid">
      {showEditor && <Panel id="files" order={1} ref={filesPanel} defaultSize={16} minSize={12} maxSize={30} collapsible collapsedSize={0} onCollapse={() => setFilesCollapsed(true)} onExpand={() => setFilesCollapsed(false)}>
        <aside className="left-panel"><section className={`files-panel${fileDragActive ? " drop-active" : ""}`} onDragEnter={(event) => { if (!event.dataTransfer.types.includes("Files")) return; event.preventDefault(); if (!readOnly && !uploadingFiles) setFileDragActive(true); }} onDragOver={(event) => { if (!event.dataTransfer.types.includes("Files")) return; event.preventDefault(); event.dataTransfer.dropEffect = readOnly || uploadingFiles ? "none" : "copy"; }} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFileDragActive(false); }} onDrop={(event) => { event.preventDefault(); setFileDragActive(false); if (!readOnly && !uploadingFiles) void uploadFiles(Array.from(event.dataTransfer.files)); }}><div className="panel-title"><span>{t("common.files")}</span><span className="file-tools"><button aria-label={t("navigation.quickOpen")} title={`${t("navigation.quickOpen")} (Ctrl/Cmd+P)`} onClick={() => setQuickOpen(true)}><FileSearch size={15} /></button><button aria-label={t("navigation.projectSearch")} title={`${t("navigation.projectSearch")} (Ctrl/Cmd+Shift+F)`} onClick={() => setProjectSearchOpen(true)}><Search size={15} /></button>{!readOnly && <><button disabled={uploadingFiles} aria-label={t("editor.uploadAttachment")} title={t("editor.uploadTo", { folder: selectedFolder || t("editor.projectRoot") })} onClick={() => uploadInput.current?.click()}><Upload size={15} /></button><button aria-label={t("editor.newFolder")} title={t("editor.newFolder")} onClick={() => { setNewFolderName(""); setNewFolderOpen(true); }}><FolderPlus size={15} /></button><button aria-label={t("editor.newFile")} title={t("editor.newFile")} onClick={() => { setNewFilePath(selectedFolder ? `${selectedFolder}/` : ""); setNewFileOpen(true); }}><FilePlus2 size={15} /></button><input ref={uploadInput} type="file" multiple hidden onChange={(event) => void upload(event)} /></>}<button aria-label={t("editor.collapseFiles")} title={t("editor.collapseFiles")} onClick={toggleFilesPanel}><PanelLeftClose size={15} /></button></span></div>
          {fileDragActive && <div className="file-drop-overlay"><Upload size={24} /><strong>{t("editor.dropFiles")}</strong><span>{t("editor.uploadTo", { folder: selectedFolder || t("editor.projectRoot") })}</span></div>}
          <div className="file-list" style={{ fontSize: `${editorPreferences.fontSize}px` }}><div className={`file-entry folder-entry root-entry${selectedFolder === "" ? " selected" : ""}`}><button className="file-entry-main" onClick={() => setSelectedFolder("")}><FolderOpen size={15} /><span>{t("editor.projectRoot")}</span></button></div>{visibleEntries.map((entry) => {
            const depth = entry.path.split("/").length - 1;
            const name = entry.path.split("/").at(-1);
            const expanded = expandedFolders.has(entry.path);
            const rootDocument = rootDocuments.has(entry.path);
            const compileTarget = activeMainFile === entry.path;
            const canDelete = entry.path !== project.mainFile && !project.mainFile.startsWith(`${entry.path}/`);
            if (entry.type === "directory") return <div className={`file-entry folder-entry${selectedFolder === entry.path ? " selected" : ""}`} style={{ paddingLeft: `${depth * 13 + 5}px` }} key={entry.path}><button className="file-entry-main" title={entry.path} onClick={() => { setSelectedFolder(entry.path); setExpandedFolders((current) => { const next = new Set(current); if (next.has(entry.path)) next.delete(entry.path); else next.add(entry.path); return next; }); }}>{expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}<Folder size={14} /><span>{name}</span></button>{!readOnly && <><button className="file-entry-action" title={t("editor.move")} aria-label={t("editor.move")} onClick={() => { setMoveEntry(entry); setMoveDestination(""); }}><Move size={13} /></button>{canDelete && <button className="file-entry-action danger-text" title={t("editor.deletePath")} aria-label={t("editor.deletePath")} onClick={() => { setDeleteEntry(entry); setFileDialogError(""); }}><Trash2 size={13} /></button>}</>}</div>;
            return <div className={`file-entry${activeFile === entry.path ? " active" : ""}${rootDocument ? " root-document" : ""}${compileTarget ? " compile-target" : ""}`} style={{ paddingLeft: `${depth * 13 + 18}px` }} key={entry.path}><button className="file-entry-main" title={compileTarget ? t("editor.currentMainDocument", { path: entry.path }) : rootDocument ? t("editor.mainDocumentCandidate", { path: entry.path }) : entry.path} onClick={() => openFile(entry)}>{rootDocument ? <BookOpen size={13} /> : <FileText size={13} />}<span>{name}</span>{compileTarget && <small>{t("editor.currentMainShort")}</small>}</button>{!readOnly && <><button className="file-entry-action" title={t("editor.move")} aria-label={t("editor.move")} onClick={() => { setMoveEntry(entry); setMoveDestination(""); }}><Move size={13} /></button>{canDelete && <button className="file-entry-action danger-text" title={t("editor.deletePath")} aria-label={t("editor.deletePath")} onClick={() => { setDeleteEntry(entry); setFileDialogError(""); }}><Trash2 size={13} /></button>}</>}</div>;
          })}</div></section>
          <section className="outline-panel"><div className="panel-title"><span><ListTree size={14} />{t("common.outline")}</span></div><div className="outline">{outline.map((item, i) => <button className={`outline-item${activeFile === item.path && sourceCursor.line === item.line ? " current" : ""}`} key={`${item.path}-${item.line}-${i}`} title={`${item.path}:${item.line}`} onClick={() => { jumpToSource(item.path, item.line, 1); void syncSourceToPdf(item.path, item.line, 1); }}><span className="outline-guides" aria-hidden style={{ width: `${item.level * 12}px` }} /><small>{item.path === activeFile ? item.line : item.path.split("/").at(-1)}</small><span className="outline-title">{item.title}</span></button>)}{outline.length === 0 && <p className="muted padded">{t("editor.noOutline")}</p>}</div></section>
        </aside>
      </Panel>}
      {showEditor && <PanelResizeHandle className="resize-handle"><GripVertical size={12} /></PanelResizeHandle>}
      {showEditor && <Panel id="source" order={2} defaultSize={42} minSize={22}>
        <main className="source-panel">
          {editorPreferences.openFilesInTabs && openTabs.length > 0 && (
            <div className="editor-tabs-bar" role="tablist" aria-label={t("editor.openFiles")}>
              <div className="editor-tabs-scroll">
                {openTabs.map((tabPath, index) => {
                  const isActive = tabPath === activeFile;
                  const isMain = tabPath === (activeMainFile || project.mainFile);
                  const fileName = tabPath.split("/").at(-1) || tabPath;
                  return (
                    <div className={`editor-tab-item${isActive ? " active" : ""}`} role="presentation" key={tabPath}>
                      <button
                      id={`editor-tab-${encodeURIComponent(tabPath)}`}
                      type="button"
                      role="tab"
                      aria-selected={isActive}
                      aria-controls="editor-source-content"
                      tabIndex={isActive ? 0 : -1}
                      className={`editor-tab${isActive ? " active" : ""}${isMain ? " main-tab" : ""}`}
                      onClick={() => activateTab(tabPath)}
                      onKeyDown={(event) => handleTabKeyDown(event, index)}
                      title={tabPath}
                    >
                      <span className="editor-tab-icon">
                        {isMain ? <BookOpen size={13} /> : <FileText size={13} />}
                      </span>
                      <span className="editor-tab-title">{fileName}</span>
                      {isMain && <small className="editor-tab-badge">{t("editor.currentMainShort")}</small>}
                    </button>
                    <button
                      type="button"
                      className="editor-tab-close"
                      title={t("common.close")}
                      aria-label={`${t("common.close")} ${fileName}`}
                      onClick={() => closeTab(tabPath)}
                    >
                      <X size={12} />
                    </button>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
          <div id="editor-source-content" className="editor-content-container">
            <Suspense fallback={<div className="preview-empty"><LoaderCircle className="spin" size={22} /><span>{t("common.loading")}</span></div>}>
              <LatexEditor key={activeFile} value={content} readOnly={readOnly} comments={comments} focusComment={focusComment} preferences={editorPreferences} completionIndex={completionIndex} spellCheckIssues={spellCheck.issues} spellCheckJump={spellCheck.jump} jumpTo={loadedFile === activeFile && sourceJump?.path === activeFile ? sourceJump : null} searchRequest={0} collaboration={collaborativeText ? { text: collaborativeText, awareness: collaboration.awareness, undoManager: readOnly ? undefined : collaboration.getUndoManager(activeFile) } : undefined} onChange={updateEditorContent} onSelection={(selectedText, startOffset, endOffset) => setSelection({ selectedText, startOffset, endOffset })} onCommentClick={(id) => { const comment = comments.find((item) => item.id === id); if (comment) { setFocusComment({ ...comment }); setSidePanel("comments"); } }} onSpellCheckReplace={replaceSpellCheckIssue} onCursor={updateSourceCursor} />
            </Suspense>
            {editorNotice && <div className="editor-centered-notice" role="status" aria-live="polite">{editorNotice}</div>}
          </div>
        </main>
      </Panel>}
      {showEditor && showPreview && <PanelResizeHandle className="resize-handle sync-resize-handle"><GripVertical className="resize-grip" size={12} /><span className="sync-direction-buttons" onPointerDown={(event) => event.stopPropagation()}><button disabled={!pdfViewport || !canSyncWithPdf} title={canSyncWithPdf ? t("editor.showInSource") : t("editor.syncTexOnlyForMain")} aria-label={t("editor.showInSource")} onClick={() => { if (!canSyncWithPdf) { setNotice(t("editor.syncTexOnlyForMain")); return; } syncVisiblePdfToSource(); }}><span aria-hidden>←</span></button><button disabled={!activeFile || !pdfUrl || !canSyncWithPdf} title={canSyncWithPdf ? t("editor.showInPdf") : t("editor.syncTexOnlyForMain")} aria-label={t("editor.showInPdf")} onClick={() => { if (!canSyncWithPdf) { setNotice(t("editor.syncTexOnlyForMain")); return; } void syncSourceToPdf(activeFile, sourceCursor.line, sourceCursor.column); }}><span aria-hidden>→</span></button></span></PanelResizeHandle>}
      {showPreview && <Panel id="preview" order={3} defaultSize={42} minSize={22}>
        <section className="preview-panel">
          <div className="preview-tabs">
            <div className="preview-tab-list" role="tablist" aria-label={t("editor.outputTabs")}>
              <button role="tab" aria-selected={previewTab === "pdf"} className={`pdf-tab${previewTab === "pdf" ? " active" : ""}`} onClick={() => selectPreviewTab("pdf")} title={pdfCompiledAt ? t("editor.pdfCompiledAtFor", { file: activeMainFile, time: new Date(pdfCompiledAt).toLocaleString(i18n.resolvedLanguage) }) : t("editor.currentMainDocument", { path: activeMainFile })}><FileText size={16} /><span className="pdf-tab-label">PDF · {pdfTargetLabel}{pdfCompiledLabel && <small>{pdfCompiledLabel}</small>}</span></button>
              <button role="tab" aria-selected={previewTab === "diagnostics"} className={`diagnostics-tab${previewTab === "diagnostics" ? " active" : ""}`} onClick={() => setPreviewTab("diagnostics")}><ScrollText size={14} />{t("editor.outputTabs")}<span>{diagnosticCount}</span></button>
            </div>
            {pdfDownloadUrl && <a className="pdf-download-top" href={pdfDownloadUrl} download title={t("editor.downloadPdf")} aria-label={t("editor.downloadPdf")}><Download size={15} /><span>{t("editor.downloadPdf")}</span></a>}
          </div>
          {previewTab === "diagnostics" && <div className="preview-subtabs" role="tablist" aria-label={t("editor.outputTabs")}>
            <button role="tab" aria-selected={diagnosticTab === "log"} className={diagnosticTab === "log" ? "active" : ""} onClick={() => selectPreviewTab("log")}><ScrollText size={13} />{t("editor.log")}</button>
            <button role="tab" aria-selected={diagnosticTab === "warnings"} className={diagnosticTab === "warnings" ? "active" : ""} onClick={() => selectPreviewTab("warnings")}><AlertTriangle size={13} />{t("editor.warnings")}<span>{compileMessages.warnings.length}</span></button>
            <button role="tab" aria-selected={diagnosticTab === "errors"} className={diagnosticTab === "errors" ? "active" : ""} onClick={() => selectPreviewTab("errors")}><XCircle size={13} />{t("editor.errors")}<span>{compileMessages.errors.length}</span></button>
            <button role="tab" aria-selected={diagnosticTab === "artifacts"} className={diagnosticTab === "artifacts" ? "active" : ""} onClick={() => selectPreviewTab("artifacts")}><PackageOpen size={13} />{t("editor.artifacts")}<span>{artifacts.length}</span></button>
            <button role="tab" aria-selected={diagnosticTab === "clean"} className={diagnosticTab === "clean" ? "active" : ""} onClick={() => selectPreviewTab("clean")}><Eraser size={13} />{t("editor.clean")}</button>
          </div>}
          <div className={`preview-content preview-${previewTab} ${previewTab === "diagnostics" ? `preview-${diagnosticTab}` : ""}`}>
            {previewTab === "pdf" && (pdfUrl ? <Suspense fallback={<div className="pdf-loading-state" role="status" aria-live="polite"><LoaderCircle className="spin" size={24} /><span>{t("editor.loadingPdf")}</span></div>}><PdfPreview url={pdfUrl} target={pdfTarget} compiling={compileBusy} onViewportLocation={(page, x, y) => setPdfViewport({ page, x, y })} onDoubleClickLocation={(page, x, y) => { setPdfViewport({ page, x, y }); if (!canSyncWithPdf) { setNotice(t("editor.syncTexOnlyForMain")); return; } void syncPdfToSource(page, x, y); }} /></Suspense> : pdfLoading ? <div className="pdf-loading-state" role="status" aria-live="polite"><LoaderCircle className="spin" size={24} /><span>{t("editor.loadingPdf")}</span></div> : <div className="preview-empty"><FileText size={28} /><strong>{t("editor.preview")}</strong><span>{t("editor.previewHint")}</span></div>)}
            {previewTab === "diagnostics" && diagnosticTab === "log" && <CompileOutput lines={compileLog ? compileLog.split("\n") : []} empty={localCompiling ? t("editor.compiling") : t("editor.noLog")} />}
            {previewTab === "diagnostics" && diagnosticTab === "warnings" && (compileDiagnostics
              ? <CompileDiagnosticOutput tone="warning" diagnostics={compileDiagnostics.warnings} files={files} empty={t("editor.noWarnings")} onJump={(path, line, column) => { if (workspaceLayout === "pdf-only") changeWorkspaceLayout("editor-pdf"); jumpToSource(path, line, column); }} />
              : <CompileOutput tone="warning" lines={compileMessages.warnings} empty={t("editor.noWarnings")} />)}
            {previewTab === "diagnostics" && diagnosticTab === "errors" && (compileDiagnostics
              ? <CompileDiagnosticOutput tone="error" diagnostics={compileDiagnostics.errors} files={files} empty={t("editor.noErrors")} onJump={(path, line, column) => { if (workspaceLayout === "pdf-only") changeWorkspaceLayout("editor-pdf"); jumpToSource(path, line, column); }} />
              : <CompileOutput tone="error" lines={compileMessages.errors} empty={t("editor.noErrors")} />)}
            {previewTab === "diagnostics" && diagnosticTab === "artifacts" && <CompileArtifacts projectId={projectId} mainFile={activeMainFile} artifacts={artifacts} preview={artifactPreview} loading={artifactLoading} onView={(artifact) => void viewArtifact(artifact)} />}
            {previewTab === "diagnostics" && diagnosticTab === "clean" && <CompileCleanup mainFile={activeMainFile} disabled={readOnly || !collaborationSynced || compileBusy} cleaning={cleaning} onCleanCache={() => setCleanMode("cache")} onCleanArtifacts={() => setCleanMode("artifacts")} />}
          </div>
        </section>
      </Panel>}
      {sidePanel && <><PanelResizeHandle className="resize-handle"><GripVertical size={12} /></PanelResizeHandle><Panel id="context" order={4} defaultSize={20} minSize={15} maxSize={38}><aside className="context-panel"><div className="drawer-title"><strong>{sidePanel === "comments" ? t("editor.sourceComments") : t("editor.projectSettings")}</strong><button aria-label={t("common.close")} onClick={() => setSidePanel(null)}><X size={17} /></button></div>
          {sidePanel === "comments" && <div className="comments">{comments.map((comment) => <CommentThread key={comment.id} comment={comment} currentUserId={user.id} onFocus={() => setFocusComment({ ...comment })} onToggle={() => void toggleComment(comment)} onReply={(content) => replyToComment(comment, content)} onEdit={(content) => editComment(comment, content)} onDelete={() => deleteComment(comment)} onEditReply={(replyId, content) => editCommentReply(comment, replyId, content)} onDeleteReply={(replyId) => deleteCommentReply(comment, replyId)} />)}{comments.length === 0 && <p className="muted padded">{t("editor.noComments")}</p>}</div>}
          {sidePanel === "settings" && <ProjectSettings project={project} projectId={projectId} site={site} files={files} dictionaryWords={dictionaryWords} onDictionaryChange={setDictionaryWords} editorPreferences={editorPreferences} onEditorPreferences={updateEditorPreferences} spellCheckCount={spellCheck.summary?.total ?? null} spellCheckUniqueCount={spellCheck.summary?.unique ?? null} spellCheckIndex={spellCheck.summary ? spellCheck.index : -1} onSpellCheckNavigate={spellCheck.jumpToIssue} onProject={setProject} />}
        </aside></Panel></>}
    </PanelGroup>
    <Modal open={Boolean(resourcePreview)} extraWide={resourcePreview?.kind === "image" || resourcePreview?.kind === "pdf" || resourcePreview?.kind === "text"} title={resourcePreview?.path ?? ""} description={resourcePreview?.kind === "large" ? t("editor.resourceTooLarge", { size: formatFileSize(resourcePreview.size), limit: "10 MB" }) : t(`editor.resourcePreview.${resourcePreview?.kind ?? "text"}`)} onOpenChange={(open) => { if (!open) { setResourcePreview(null); setResourcePreviewLoading(false); } }} footer={resourcePreview && <a className="primary resource-download" href={`${resourcePreview.url}&download=1`} download><Download size={14} />{t("editor.downloadResource")}</a>}>
      {resourcePreview?.kind === "large" && <div className="resource-preview-message"><FileArchive size={34} /><strong>{t("editor.resourceTooLargeTitle")}</strong><span>{t("editor.resourceTooLargeDescription")}</span></div>}
      {resourcePreview?.kind === "unsupported" && <div className="resource-preview-message"><FileArchive size={34} /><strong>{t("editor.resourceUnsupportedTitle")}</strong><span>{t("editor.resourceUnsupportedDescription")}</span></div>}
      {resourcePreview?.kind === "image" && <div className="resource-image-wrap"><img className="resource-image" src={resourcePreview.url} alt={resourcePreview.path} /></div>}
      {resourcePreview?.kind === "pdf" && <iframe className="resource-pdf" src={resourcePreview.url} title={resourcePreview.path} />}
      {resourcePreview?.kind === "text" && (resourcePreviewLoading ? <div className="resource-preview-message"><LoaderCircle className="spin" size={24} /><span>{t("common.loading")}</span></div> : <pre className="resource-text">{resourcePreview.content}</pre>)}
    </Modal>
    <ConfirmDialog open={Boolean(uploadConflict)} title={t("editor.uploadOverwriteTitle")} description={t("editor.uploadOverwriteDescription", { files: uploadConflict?.collisions.join(", ") ?? "" })} confirmLabel={t("editor.uploadOverwrite")} danger onCancel={() => setUploadConflict(null)} onConfirm={() => { const pending = uploadConflict; setUploadConflict(null); if (pending) void uploadFiles(pending.files, new Set(pending.collisions), pending.directory); }} />
    <ConfirmDialog open={Boolean(cleanMode)} title={cleanMode === "cache" ? t("editor.cleanCacheConfirmTitle") : t("editor.cleanArtifactsConfirmTitle")} description={cleanMode === "cache" ? t("editor.cleanCacheConfirmDescription") : t("editor.cleanArtifactsConfirmDescription")} confirmLabel={t("editor.cleanConfirm")} danger={cleanMode === "artifacts"} onCancel={() => setCleanMode(null)} onConfirm={() => { const mode = cleanMode; setCleanMode(null); if (mode) void cleanCompile(mode); }} />
    <Modal open={newFileOpen} title={t("editor.newFile")} description={t("editor.newFileDescription")} onOpenChange={(open) => { setNewFileOpen(open); if (!open) setFileDialogError(""); }} footer={<><button onClick={() => setNewFileOpen(false)}>{t("common.cancel")}</button><button className="primary" onClick={() => void createFile()}>{t("common.create")}</button></>}><>{fileDialogError && <p className="error dialog-error">{fileDialogError}</p>}<label className="form-field">{t("editor.filePath")}<input autoFocus value={newFilePath} onChange={(event) => setNewFilePath(event.target.value)} /></label></></Modal>
    <Modal open={newFolderOpen} title={t("editor.newFolder")} description={t("editor.folderDestination", { folder: selectedFolder || t("editor.projectRoot") })} onOpenChange={(open) => { setNewFolderOpen(open); if (!open) setFileDialogError(""); }} footer={<><button onClick={() => setNewFolderOpen(false)}>{t("common.cancel")}</button><button className="primary" onClick={() => void createFolder()}>{t("common.create")}</button></>}><>{fileDialogError && <p className="error dialog-error">{fileDialogError}</p>}<label className="form-field">{t("editor.folderName")}<input autoFocus value={newFolderName} onChange={(event) => setNewFolderName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void createFolder(); }} /></label></></Modal>
    <Modal open={Boolean(moveEntry)} title={t("editor.moveTitle", { name: moveEntry?.path.split("/").at(-1) ?? "" })} description={t("editor.moveDescription")} onOpenChange={(open) => { if (!open) { setMoveEntry(null); setFileDialogError(""); } }} footer={<><button onClick={() => setMoveEntry(null)}>{t("common.cancel")}</button><button className="primary" onClick={() => void movePath()}>{t("editor.move")}</button></>}><>{fileDialogError && <p className="error dialog-error">{fileDialogError}</p>}<label className="form-field">{t("editor.destinationFolder")}<select value={moveDestination} onChange={(event) => setMoveDestination(event.target.value)}><option value="">{t("editor.projectRoot")}</option>{directoryEntries.filter((directory) => moveEntry?.type !== "directory" || (directory.path !== moveEntry.path && !directory.path.startsWith(`${moveEntry.path}/`))).map((directory) => <option value={directory.path} key={directory.path}>{directory.path}</option>)}</select></label></></Modal>
    <Modal open={Boolean(deleteEntry)} title={t("editor.deletePathTitle", { name: deleteEntry?.path.split("/").at(-1) ?? "" })} description={deleteActiveSessions.length
      ? t("editor.deletePathActiveDescription", { path: deleteEntry?.path ?? "", users: [...new Set(deleteActiveSessions.map((session) => session.name))].join(", ") })
      : t("editor.deletePathDescription", { path: deleteEntry?.path ?? "" })} onOpenChange={(open) => { if (!open) { setDeleteEntry(null); setFileDialogError(""); } }} footer={<><button onClick={() => setDeleteEntry(null)}>{t("common.cancel")}</button><button className="danger" onClick={() => void removePath()}>{t("common.delete")}</button></>}><>{fileDialogError && <p className="error dialog-error">{fileDialogError}</p>}{deleteActiveSessions.length > 0 && <p className="warning"><AlertTriangle size={15} />{t("editor.deletePathWillClose")}</p>}</></Modal>
    <Modal open={commentOpen} title={t("editor.addComment")} description={selection.selectedText ? t("editor.commentDescription", { count: selection.endOffset - selection.startOffset }) : t("editor.pointComment")} onOpenChange={setCommentOpen} footer={<><button onClick={() => setCommentOpen(false)}>{t("common.cancel")}</button><button className="primary" onClick={() => void addComment()}>{t("editor.addComment")}</button></>}><label className="form-field">{t("editor.commentContent")}<textarea autoFocus rows={5} value={commentText} onChange={(event) => setCommentText(event.target.value)} /></label>{selection.selectedText && <blockquote className="selection-preview">{selection.selectedText}</blockquote>}</Modal>
    <ShareDialog open={shareOpen} onOpenChange={setShareOpen} project={project} projectId={projectId} />
    {quickOpen && <Suspense fallback={null}><QuickOpenDialog open files={files} onOpenChange={setQuickOpen} onOpenFile={(filePath) => { const entry = files.find((file) => file.path === filePath); if (entry) openFile(entry); }} /></Suspense>}
    {projectSearchOpen && <Suspense fallback={null}><ProjectSearchDialog open project={project} onOpenChange={setProjectSearchOpen} onJump={(filePath, line, column) => { if (workspaceLayout === "pdf-only") changeWorkspaceLayout("editor-pdf"); jumpToSource(filePath, line, column); }} /></Suspense>}
    {historyOpen && <Suspense fallback={null}><HistoryDialog open onOpenChange={setHistoryOpen} project={project} onBeforeMutation={project.permission === "read" ? async () => true : save} /></Suspense>}
    {project.ownerId === user.id && gitOpen && <Suspense fallback={null}><GitDialog open onOpenChange={setGitOpen} project={project} onBeforeMutation={save} /></Suspense>}
  </div>;
}

function hasDocumentClass(source: string): boolean {
  const withoutComments = source.split(/(?<=\n)/).map((line) => {
    for (let index = 0; index < line.length; index += 1) {
      if (line[index] !== "%") continue;
      let slashes = 0;
      for (let cursor = index - 1; cursor >= 0 && line[cursor] === "\\"; cursor -= 1) slashes += 1;
      if (slashes % 2 === 0) return `${line.slice(0, index)}${line.endsWith("\n") ? "\n" : ""}`;
    }
    return line;
  }).join("");
  const withoutVerbatim = withoutComments
    .replace(/\\verb\*?([^\s]).*?\1/g, "")
    .replace(/\\begin\{(?:verbatim\*?|Verbatim|lstlisting|minted)\}[\s\S]*?\\end\{(?:verbatim\*?|Verbatim|lstlisting|minted)\}/g, "");
  return /\\documentclass\s*(?:\[[^\]]*\]\s*)?\{/.test(withoutVerbatim);
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function parseOutline(content: string): Array<{ level: number; title: string; line: number }> {
  const result: Array<{ level: number; title: string; line: number }> = [];
  const pattern = /^\s*\\(part|chapter|section|subsection|subsubsection)\*?(?:\[[^\]]*\])?\{([^}]*)\}/;
  const levels: Record<string, number> = { part: 0, chapter: 0, section: 1, subsection: 2, subsubsection: 3 };
  content.split("\n").forEach((line, index) => {
    const match = line.match(pattern);
    if (match) result.push({ level: levels[match[1]], title: match[2], line: index + 1 });
  });
  return result;
}
