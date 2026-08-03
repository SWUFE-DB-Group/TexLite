import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { api, ApiError, localizedResponseError } from "./api";
import { LatexEditor, type SpellCheckIssue } from "./LatexEditor";
import type { PdfTarget } from "./PdfPreview";
import { ConfirmDialog, Modal } from "./Dialog";
import type { Comment, FileEntry, LatexCompletionIndex, Project, ProjectTag, SiteConfig, TagColor, User } from "./types";
import { LanguageSwitcher } from "./LanguageSwitcher";
import { GitDialog } from "./GitDialog";
import i18n from "./i18n";
import {
  AlertTriangle, ArrowDownUp, ArrowLeft, BookOpen, CalendarDays, Check, CheckCircle2, ChevronDown, ChevronRight, Columns2, Dices, Download, FileArchive, FilePlus2, FileText,
  Folder, FolderOpen, FolderPlus, GitBranch, GripVertical, History, ListTree, LoaderCircle, MessageSquare, MessageSquarePlus, PackageOpen,
  Move, PanelLeft, PanelLeftClose, PanelLeftOpen, PanelRight, Pencil, Play, Reply, RotateCcw, Save, ScrollText, Send,
  Settings, Sparkles, SpellCheck2, Tags, Trash2, Type, Upload, UserPlus, Users, WrapText, X, XCircle
} from "lucide-react";
import { Panel, PanelGroup, PanelResizeHandle, type ImperativePanelHandle } from "react-resizable-panels";
import {
  editorFonts, loadEditorPreferences, saveEditorPreferences, type EditorPreferences
} from "./editorPreferences";
import { classifyCompileLog } from "./compileLog";
import {
  ProjectCollaboration, avatarInitial, sharedCompileState, type ActiveSession, type CollaborationStatus,
  type FilesEvent, type SharedCompileState
} from "./collaboration";

const loadPdfPreview = () => import("./PdfPreview");
const PdfPreview = lazy(() => loadPdfPreview().then((module) => ({ default: module.PdfPreview })));
const MIN_PASSWORD_LENGTH = 8;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : i18n.t("errors.generic");
}

export function App() {
  const { t } = useTranslation();
  const [site, setSite] = useState<SiteConfig>({ siteName: "texLite", adminEmail: "" });
  const [user, setUser] = useState<User | null | undefined>();
  const [projectId, setProjectId] = useState<string | null>(null);
  const [dashboardCache, setDashboardCache] = useState<{ userId: string; projects: Project[]; tags: ProjectTag[] } | null>(null);

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
    return <ProjectWorkspace site={site} user={user} projectId={projectId} onBack={() => setProjectId(null)} />;
  }
  const cachedDashboard = dashboardCache?.userId === user.id ? dashboardCache : null;
  return <Dashboard site={site} user={user}
    initialData={cachedDashboard ? { projects: cachedDashboard.projects, tags: cachedDashboard.tags } : null}
    onDataChange={(projects, tags) => setDashboardCache({ userId: user.id, projects, tags })}
    onUser={(next) => { if (!next || next.id !== user.id) setDashboardCache(null); setUser(next); }}
    onOpenProject={setProjectId} />;
}

function SiteLogo({ siteName, compact = false, auth = false }: { siteName: string; compact?: boolean; auth?: boolean }) {
  return <span className={`site-logo${compact ? " compact" : ""}${auth ? " auth-logo" : ""}`}>
    <img src="/logo.svg" alt={siteName} />
  </span>;
}

function SiteFooter() {
  const { t } = useTranslation();
  const repositoryUrl = "https://github.com/SWUFE-DB-Group/TexLite";
  return <footer className="site-footer"><span>{t("footer.copyright", { year: new Date().getFullYear() })} <a href={repositoryUrl} target="_blank" rel="noreferrer">TexLite</a></span><span>{t("footer.credit")}</span></footer>;
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
  initialData: { projects: Project[]; tags: ProjectTag[] } | null;
  onDataChange: (projects: Project[], tags: ProjectTag[]) => void;
  onUser: (user: User | null) => void;
  onOpenProject: (id: string) => void;
}) {
  const { t } = useTranslation();
  const [projects, setProjects] = useState<Project[]>(() => initialData?.projects ?? []);
  const [tags, setTags] = useState<ProjectTag[]>(() => initialData?.tags ?? []);
  const [hasLoaded, setHasLoaded] = useState(Boolean(initialData));
  const [adminOpen, setAdminOpen] = useState(false);
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
  const [deleteProject, setDeleteProject] = useState<Project | null>(null);
  const [view, setView] = useState<"grid" | "list">(() => localStorage.getItem("texlite-project-view") === "list" ? "list" : "grid");
  const [sort, setSort] = useState<"updated" | "created">(() => localStorage.getItem("texlite-project-sort") === "created" ? "created" : "updated");
  const load = () => Promise.all([
    api<{ projects: Project[] }>("/api/projects"),
    api<{ tags: ProjectTag[] }>("/api/tags")
  ]).then(([projectResult, tagResult]) => {
    setProjects(projectResult.projects); setTags(tagResult.tags); setHasLoaded(true);
  }).catch((e) => setError(errorMessage(e)));
  useEffect(() => { void load(); }, []);
  useEffect(() => {
    if (hasLoaded) onDataChange(projects, tags);
  }, [projects, tags, hasLoaded]);
  const changeView = (next: "grid" | "list") => { setView(next); localStorage.setItem("texlite-project-view", next); };
  const changeSort = (next: "updated" | "created") => { setSort(next); localStorage.setItem("texlite-project-sort", next); };
  const createProject = async () => {
    if (!newProjectName.trim()) return;
    try {
      const { project } = await api<{ project: Project }>("/api/projects", { method: "POST", body: JSON.stringify({ name: newProjectName }) });
      setCreateOpen(false); setNewProjectName("");
      const nextProjects = [project, ...projects];
      setProjects(nextProjects); onDataChange(nextProjects, tags);
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
      const nextProjects = [project, ...projects];
      setProjects(nextProjects); onDataChange(nextProjects, tags);
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

  const removeProject = async () => {
    if (!deleteProject) return;
    try {
      await api(`/api/projects/${deleteProject.id}`, { method: "DELETE" });
      setProjects((current) => current.filter((project) => project.id !== deleteProject.id));
      setDeleteProject(null);
    } catch (e) { setError(errorMessage(e)); }
  };

  const filtered = projects.filter((project) => {
    const needle = query.trim().toLocaleLowerCase();
    const matchesText = !needle || [project.name, project.ownerDisplayName, project.ownerUsername]
      .some((value) => value?.toLocaleLowerCase().includes(needle));
    const matchesTag = !tagFilter || project.tags?.some((tag) => tag.id === tagFilter);
    return matchesText && matchesTag;
  }).sort((left, right) => {
    const leftTime = sort === "created" ? left.createdAt : left.updatedAt;
    const rightTime = sort === "created" ? right.createdAt : right.updatedAt;
    return rightTime.localeCompare(leftTime) || left.name.localeCompare(right.name);
  });
  const colors: TagColor[] = ["red", "orange", "yellow", "green", "blue", "purple", "gray"];
  const formatTime = (value: string) => new Date(value).toLocaleString(i18n.resolvedLanguage);

  return <div className="page">
    <header className="topbar">
      <span className="site-title">{site.siteName}</span><SiteLogo siteName={site.siteName} />
      <div className="top-actions">
        {user.role === "admin" && <button className="ghost" onClick={() => setAdminOpen(!adminOpen)}>{adminOpen ? t("users.back") : t("users.manage")}</button>}
        <LanguageSwitcher compact /><span className="top-user-identity"><strong>{user.displayName}</strong><small>@{user.username}</small></span><button className="ghost" onClick={logout}>{t("auth.logout")}</button>
      </div>
    </header>
    {adminOpen ? <AdminUsers currentUser={user} /> : <main className="dashboard">
      <div className="section-title"><div><h1>{t("projects.title")}</h1><p className="muted">{user.canCreateProjects ? t("projects.subtitle") : t("projects.restricted")}</p></div><div className="section-actions"><button onClick={() => setTagCreateOpen(true)}>{t("tags.create")}</button>{user.canCreateProjects && <><button onClick={() => { setImportError(""); setImportOpen(true); }}>{t("projects.upload")}</button><button className="primary" onClick={() => setCreateOpen(true)}>{t("projects.new")}</button></>}</div></div>
      {error && <p className="error">{error}</p>}
      <div className="project-toolbar"><input type="search" placeholder={t("projects.search")} value={query} onChange={(event) => setQuery(event.target.value)} /><div className="tag-filters"><button className={!tagFilter ? "active" : ""} onClick={() => setTagFilter("")}>{t("projects.allTags")}</button>{tags.map((tag) => <button key={tag.id} className={tagFilter === tag.id ? "active" : ""} onClick={() => setTagFilter(tagFilter === tag.id ? "" : tag.id)}><TagDot color={tag.color} />{tag.name}</button>)}</div><label className="project-sort"><ArrowDownUp size={14} /><span>{t("projects.sortBy")}</span><select value={sort} onChange={(event) => changeSort(event.target.value as "updated" | "created")}><option value="updated">{t("projects.sortModified")}</option><option value="created">{t("projects.sortCreated")}</option></select></label><div className="view-toggle"><button className={view === "grid" ? "active" : ""} onClick={() => changeView("grid")} title={t("projects.grid")}>▦</button><button className={view === "list" ? "active" : ""} onClick={() => changeView("list")} title={t("projects.list")}>☷</button></div></div>
      <div className={`project-grid ${view === "list" ? "list-view" : ""}`}>
        {filtered.map((project) => <article className="project-card" key={project.id}>
          <button className="project-card-open" onClick={() => onOpenProject(project.id)}>
            <span className="owner-badge" title={project.ownerDisplayName ?? project.ownerUsername}>{project.ownerDisplayName ?? project.ownerUsername}</span>
            <span className="project-card-main"><strong>{project.name}</strong><span className="project-tags">{project.tags?.map((tag) => <span className={`tag tag-${tag.color}`} key={tag.id}>{tag.name}</span>)}</span></span>
            <dl className="project-meta">
              <div><dt><CalendarDays aria-hidden size={13} />{t("projects.created")}</dt><dd><time dateTime={project.createdAt}>{formatTime(project.createdAt)}</time></dd></div>
              <div><dt><History aria-hidden size={13} />{t("projects.modified")}</dt><dd title={t("projects.modifiedByUser", { time: formatTime(project.updatedAt), user: project.lastModifiedDisplayName ?? project.lastModifiedUsername ?? t("projects.deletedUser") })}><time dateTime={project.updatedAt}>{formatTime(project.updatedAt)}</time><span className="project-modified-by"> · {t("projects.byUser", { user: project.lastModifiedDisplayName ?? project.lastModifiedUsername ?? t("projects.deletedUser") })}</span></dd></div>
            </dl>
          </button>
          <div className="project-card-actions">
            <button onClick={() => setTagProject(project)}><Tags aria-hidden size={14} />{t("tags.assign")}</button>
            {project.permission === "owner" && <button onClick={() => { setRenameProject(project); setRenameValue(project.name); }}><Pencil aria-hidden size={14} />{t("projects.rename")}</button>}
            <a href={`/api/projects/${project.id}/download`} download><Download aria-hidden size={14} />{t("projects.download")}</a>
            {project.permission === "owner" && <button className="danger-text" onClick={() => setDeleteProject(project)}><Trash2 aria-hidden size={14} />{t("common.delete")}</button>}
          </div>
        </article>)}
        {filtered.length === 0 && (projects.length === 0
          ? <div className="project-empty"><span className="project-empty-icon"><Sparkles size={28} /></span><h2>{t("projects.emptyTitle")}</h2><p>{user.canCreateProjects ? t("projects.emptyDescription") : t("projects.emptyRestricted")}</p></div>
          : <div className="empty">{t("projects.noMatches")}</div>)}
      </div>
      <Modal open={createOpen} title={t("projects.new")} description={t("projects.newDescription")} onOpenChange={setCreateOpen} footer={<><button onClick={() => setCreateOpen(false)}>{t("common.cancel")}</button><button className="primary" onClick={() => void createProject()}>{t("common.create")}</button></>}>
        <label className="form-field">{t("projects.name")}<input autoFocus value={newProjectName} onChange={(event) => setNewProjectName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void createProject(); }} /></label>
      </Modal>
      <Modal open={importOpen} title={t("projects.upload")} description={t("projects.uploadDescription", { size: site.maxUploadSizeMB ?? 50 })} onOpenChange={(open) => { setImportOpen(open); if (!open) setImportError(""); }} footer={<><button onClick={() => { setImportOpen(false); setImportError(""); }}>{t("common.cancel")}</button><button className="primary" disabled={!importFile || importing} onClick={() => void importProject()}>{importing ? t("projects.importing") : t("projects.import")}</button></>}><div className="form-stack">{importError && <p className="error import-error">{importError}</p>}<div className={`upload-picker${importFile ? " has-file" : ""}`} onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; }} onDrop={(event) => { event.preventDefault(); selectImportFile(event.dataTransfer.files[0] ?? null); }}><input ref={importInput} className="sr-only" type="file" accept=".zip,application/zip" onChange={(event) => selectImportFile(event.target.files?.[0] ?? null)} /><FileArchive size={34} /><div className="upload-picker-copy"><strong>{importFile?.name ?? t("projects.chooseZip")}</strong><span>{importFile ? t("projects.selectedFileSize", { size: formatFileSize(importFile.size) }) : t("projects.dropZip")}</span></div><button type="button" onClick={() => importInput.current?.click()}><Upload size={15} />{t("projects.browse")}</button>{importFile && <button className="upload-clear" type="button" title={t("projects.clearFile")} aria-label={t("projects.clearFile")} onClick={() => { selectImportFile(null); if (importInput.current) importInput.current.value = ""; }}><X size={14} /></button>}</div><label className="form-field">{t("projects.name")}<input value={importName} onChange={(event) => setImportName(event.target.value)} /></label></div></Modal>
      <Modal open={tagCreateOpen} title={t("tags.create")} description={t("tags.createDescription")} onOpenChange={setTagCreateOpen} footer={<><button onClick={() => setTagCreateOpen(false)}>{t("common.cancel")}</button><button className="primary" onClick={() => void createTag()}>{t("common.create")}</button></>}><div className="form-stack"><label className="form-field">{t("tags.name")}<input autoFocus value={tagName} onChange={(event) => setTagName(event.target.value)} /></label><fieldset className="color-picker"><legend>{t("tags.color")}</legend>{colors.map((color) => <label key={color} className={tagColor === color ? "active" : ""}><input type="radio" name="dashboard-tag-color" checked={tagColor === color} onChange={() => setTagColor(color)} /><TagDot color={color} />{t(`tags.${color}`)}</label>)}</fieldset></div></Modal>
      <Modal open={Boolean(tagProject)} title={t("tags.assignTitle", { project: tagProject?.name ?? "" })} description={t("tags.assignDescription")} onOpenChange={(open) => { if (!open) setTagProject(null); }} footer={<button onClick={() => setTagProject(null)}>{t("common.close")}</button>}><div className="tag-assignment-list">{tags.map((tag) => <label key={tag.id}><input type="checkbox" checked={Boolean(tagProject?.tags.some((item) => item.id === tag.id))} onChange={() => void toggleProjectTag(tag)} /><TagDot color={tag.color} /><span>{tag.name}</span></label>)}{tags.length === 0 && <p className="muted">{t("tags.empty")}</p>}</div></Modal>
      <Modal open={Boolean(renameProject)} title={t("projects.renameTitle")} onOpenChange={(open) => { if (!open) setRenameProject(null); }} footer={<><button onClick={() => setRenameProject(null)}>{t("common.cancel")}</button><button className="primary" onClick={() => void rename()}>{t("projects.rename")}</button></>}><label className="form-field">{t("projects.name")}<input autoFocus value={renameValue} onChange={(event) => setRenameValue(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void rename(); }} /></label></Modal>
      <ConfirmDialog open={Boolean(deleteProject)} title={t("projects.deleteTitle")} description={t("projects.deleteDescription", { project: deleteProject?.name ?? "" })} confirmLabel={t("common.delete")} danger onCancel={() => setDeleteProject(null)} onConfirm={() => void removeProject()} />
    </main>}<SiteFooter />
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
    <div className="section-title"><div><h1>{t("users.manage")}</h1><p className="muted">{t("users.onlyAdmin")}</p></div><button className="primary" onClick={() => setCreateOpen(true)}>{t("users.add")}</button></div>
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

interface Selection { selectedText: string; startOffset: number; endOffset: number }
type PreviewTab = "pdf" | "log" | "warnings" | "errors" | "artifacts";
type WorkspaceLayout = "editor-pdf" | "editor-only" | "pdf-only";
interface SourceJump { path: string; line: number; column: number; nonce: number }
interface CompileArtifact { path: string; size: number; viewable: boolean }
type ResourcePreviewKind = "image" | "pdf" | "text" | "unsupported" | "large";
interface ResourcePreview { path: string; kind: ResourcePreviewKind; size: number; url: string; content?: string }

const WORKSPACE_LAYOUT_KEY = "texlite.workspaceLayout";
const MAX_DIRECT_RESOURCE_PREVIEW_BYTES = 10 * 1024 * 1024;

function loadWorkspaceLayout(): WorkspaceLayout {
  try {
    const saved = window.localStorage.getItem(WORKSPACE_LAYOUT_KEY);
    if (saved === "editor-pdf" || saved === "editor-only" || saved === "pdf-only") return saved;
  } catch { /* Browser storage can be unavailable in private/restricted contexts. */ }
  return "editor-pdf";
}

function ProjectWorkspace({ site, user, projectId, onBack }: {
  site: SiteConfig; user: User; projectId: string; onBack: () => void;
}) {
  const { t } = useTranslation();
  const [project, setProject] = useState<Project | null>(null);
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [dictionaryWords, setDictionaryWords] = useState<string[]>([]);
  const [spellCheckIssues, setSpellCheckIssues] = useState<SpellCheckIssue[]>([]);
  const [spellCheckSource, setSpellCheckSource] = useState("");
  const [spellCheckFile, setSpellCheckFile] = useState("");
  const [completionIndex, setCompletionIndex] = useState<LatexCompletionIndex | null>(null);
  const [activeFile, setActiveFile] = useState("");
  const [content, setContent] = useState("");
  const [loadedFile, setLoadedFile] = useState("");
  const [dirty, setDirty] = useState(false);
  const [saveState, setSaveState] = useState("editor.saved");
  const [pdfUrl, setPdfUrl] = useState("");
  const [pdfCompiledAt, setPdfCompiledAt] = useState<string | null>(null);
  const [pdfTarget, setPdfTarget] = useState<PdfTarget | null>(null);
  const [pdfViewport, setPdfViewport] = useState<{ page: number; x: number; y: number } | null>(null);
  const [sourceJump, setSourceJump] = useState<SourceJump | null>(null);
  const [sourceCursor, setSourceCursor] = useState({ line: 1, column: 1 });
  const [compileLog, setCompileLog] = useState("");
  const [compileOutcome, setCompileOutcome] = useState<"succeeded" | "failed" | null>(null);
  const [previewTab, setPreviewTab] = useState<PreviewTab>("pdf");
  const [workspaceLayout, setWorkspaceLayout] = useState<WorkspaceLayout>(loadWorkspaceLayout);
  const [artifacts, setArtifacts] = useState<CompileArtifact[]>([]);
  const [artifactPreview, setArtifactPreview] = useState<{ path: string; content: string } | null>(null);
  const [artifactLoading, setArtifactLoading] = useState(false);
  const [compiling, setCompiling] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [selection, setSelection] = useState<Selection>({ selectedText: "", startOffset: 0, endOffset: 0 });
  const [comments, setComments] = useState<Comment[]>([]);
  const [sidePanel, setSidePanel] = useState<"comments" | "settings" | null>(null);
  const [focusComment, setFocusComment] = useState<Comment | null>(null);
  const [newFileOpen, setNewFileOpen] = useState(false);
  const [newFilePath, setNewFilePath] = useState("");
  const [resourcePreview, setResourcePreview] = useState<ResourcePreview | null>(null);
  const [resourcePreviewLoading, setResourcePreviewLoading] = useState(false);
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [selectedFolder, setSelectedFolder] = useState("");
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const [moveEntry, setMoveEntry] = useState<FileEntry | null>(null);
  const [moveDestination, setMoveDestination] = useState("");
  const [filesCollapsed, setFilesCollapsed] = useState(false);
  const [commentOpen, setCommentOpen] = useState(false);
  const [commentText, setCommentText] = useState("");
  const [shareOpen, setShareOpen] = useState(false);
  const [gitOpen, setGitOpen] = useState(false);
  const [editorPreferences, setEditorPreferences] = useState<EditorPreferences>(loadEditorPreferences);
  const [collaboration] = useState(() => new ProjectCollaboration(projectId, user));
  const [collaborationStatus, setCollaborationStatus] = useState<CollaborationStatus>("connecting");
  const [collaborationSynced, setCollaborationSynced] = useState(false);
  const [activeSessions, setActiveSessions] = useState<ActiveSession[]>([]);
  const [compileState, setCompileState] = useState<SharedCompileState | null>(null);
  const [filesEvent, setFilesEvent] = useState<FilesEvent | null>(null);
  const [commentsRevision, setCommentsRevision] = useState("");
  const [dictionaryRevision, setDictionaryRevision] = useState("");
  const [fileDragActive, setFileDragActive] = useState(false);
  const uploadInput = useRef<HTMLInputElement>(null);
  const filesPanel = useRef<ImperativePanelHandle>(null);
  const compileAction = useRef<() => void>(() => undefined);
  const syncNonce = useRef(0);
  const contentRef = useRef("");
  const activeFileRef = useRef("");
  const spellCheckRequest = useRef(0);

  const updateEditorContent = (next: string) => {
    contentRef.current = next;
    setContent(next);
    setSpellCheckIssues((current) => current.length ? [] : current);
    setSpellCheckSource((current) => current ? "" : current);
    setSpellCheckFile((current) => current ? "" : current);
  };

  useEffect(() => {
    activeFileRef.current = activeFile;
    setSpellCheckIssues([]);
    setSpellCheckSource("");
    setSpellCheckFile("");
  }, [activeFile]);

  useEffect(() => {
    setSpellCheckIssues([]);
    setSpellCheckSource("");
    setSpellCheckFile("");
  }, [dictionaryWords]);

  useEffect(() => {
    const request = ++spellCheckRequest.current;
    if (!project || !activeFile || !collaborationSynced || !editorPreferences.spellCheck) {
      setSpellCheckIssues([]);
      setSpellCheckSource("");
      setSpellCheckFile("");
      return;
    }
    const source = content;
    const file = activeFile;
    const timer = window.setTimeout(() => {
      void api<{ issues: SpellCheckIssue[]; count: number }>(`/api/projects/${projectId}/spellcheck`, {
        method: "POST", body: JSON.stringify({ source })
      }).then((result) => {
        if (request !== spellCheckRequest.current || contentRef.current !== source || activeFileRef.current !== file) return;
        setSpellCheckIssues(result.issues);
        setSpellCheckSource(source);
        setSpellCheckFile(file);
      }).catch(() => undefined);
    }, 700);
    return () => window.clearTimeout(timer);
  }, [content, activeFile, project?.id, projectId, collaborationSynced, editorPreferences.spellCheck, dictionaryWords]);

  useEffect(() => {
    const refreshSessions = () => setActiveSessions(collaboration.sessions());
    const handleStatus = ({ status }: { status: CollaborationStatus }) => {
      setCollaborationStatus(status);
      if (status !== "connected") setCollaborationSynced(false);
    };
    const handleSync = (synced: boolean) => setCollaborationSynced(synced);
    const handleMeta = () => {
      const nextFilesEvent = collaboration.meta.get("filesEvent");
      if (isFilesEvent(nextFilesEvent)) setFilesEvent(nextFilesEvent);
      const nextCommentsRevision = collaboration.meta.get("commentsRevision");
      if (typeof nextCommentsRevision === "string") setCommentsRevision(nextCommentsRevision);
      const nextDictionaryRevision = collaboration.meta.get("dictionaryRevision");
      if (typeof nextDictionaryRevision === "string") setDictionaryRevision(nextDictionaryRevision);
      setCompileState(sharedCompileState(collaboration.meta.get("compileState")));
    };
    collaboration.awareness.on("change", refreshSessions);
    collaboration.provider.on("status", handleStatus);
    collaboration.provider.on("sync", handleSync);
    collaboration.meta.observe(handleMeta);
    refreshSessions(); handleMeta();
    setCollaborationStatus(collaboration.connected ? "connected" : "connecting");
    setCollaborationSynced(collaboration.synced);
    return () => {
      collaboration.awareness.off("change", refreshSessions);
      collaboration.provider.off("status", handleStatus);
      collaboration.provider.off("sync", handleSync);
      collaboration.meta.unobserve(handleMeta);
      collaboration.destroy();
    };
  }, [collaboration]);

  const loadFiles = async () => {
    const result = await api<{ files: FileEntry[] }>(`/api/projects/${projectId}/files`);
    setFiles(result.files);
  };
  const loadCompletionIndex = async () => {
    try {
      const result = await api<{ index: LatexCompletionIndex }>(`/api/projects/${projectId}/completions`);
      setCompletionIndex(result.index);
    } catch {
      setCompletionIndex(null);
    }
  };
  const loadDictionary = async () => {
    try {
      const result = await api<{ words: string[] }>(`/api/projects/${projectId}/dictionary`);
      setDictionaryWords(result.words);
    } catch {
      setDictionaryWords([]);
    }
  };
  const loadArtifacts = async () => {
    try {
      const result = await api<{ artifacts: CompileArtifact[] }>(`/api/projects/${projectId}/compile/artifacts`);
      setArtifacts(result.artifacts);
      setArtifactPreview(null);
    } catch {
      setArtifacts([]);
      setArtifactPreview(null);
    }
  };
  useEffect(() => {
    let cancelled = false;
    setPdfUrl(""); setPdfCompiledAt(null); setPdfViewport(null); setCompileOutcome(null); setCompletionIndex(null); setDictionaryWords([]); setDictionaryRevision(""); setSpellCheckIssues([]); setSpellCheckSource(""); setSpellCheckFile("");
    void loadPdfPreview();
    void Promise.all([
      api<{ project: Project }>(`/api/projects/${projectId}`),
      api<{ files: FileEntry[] }>(`/api/projects/${projectId}/files`)
    ]).then(([p, f]) => {
      if (cancelled) return;
      setProject(p.project); setFiles(f.files); setActiveFile(p.project.mainFile);
      setExpandedFolders(new Set(parentFolders(p.project.mainFile)));
    }).catch((e) => { if (!cancelled) setError(errorMessage(e)); });
    void loadCompletionIndex();
    void loadDictionary();
    void api<{ latestRun: { id: string; status: string; log: string; requestedBy: { id: string; username: string; name: string } | null } | null; pdfUrl: string | null; pdfCompiledAt: string | null }>(`/api/projects/${projectId}/compile/latest`)
      .then((latest) => {
        if (cancelled) return;
        setCompileLog(latest.latestRun?.log ?? "");
        setCompileOutcome(latest.latestRun?.status === "succeeded" || latest.latestRun?.status === "failed"
          ? latest.latestRun.status
          : null);
        if (latest.latestRun?.requestedBy && (latest.latestRun.status === "queued" || latest.latestRun.status === "running")) {
          setCompileState({
            runId: latest.latestRun.id,
            status: latest.latestRun.status,
            requestedBy: latest.latestRun.requestedBy,
            updatedAt: new Date().toISOString()
          });
        }
        if (latest.pdfUrl) {
          setPdfUrl(latest.pdfUrl);
          setPdfCompiledAt(latest.pdfCompiledAt);
          setPreviewTab("pdf");
        }
      })
      .catch(() => { if (!cancelled) { setCompileLog(""); setCompileOutcome(null); } });
    void loadArtifacts();
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  useEffect(() => {
    if (dictionaryRevision) void loadDictionary();
  }, [dictionaryRevision, projectId]);

  useEffect(() => {
    if (!compileState || (compileState.status !== "succeeded" && compileState.status !== "failed")) return;
    let cancelled = false;
    void api<{ latestRun: { id: string; status: string; log: string } | null; pdfUrl: string | null; pdfCompiledAt: string | null }>(`/api/projects/${projectId}/compile/latest`)
      .then((latest) => {
        if (cancelled || latest.latestRun?.id !== compileState.runId) return;
        setCompileLog(latest.latestRun.log);
        setCompileOutcome(compileState.status === "succeeded" ? "succeeded" : "failed");
        if (compileState.status === "succeeded" && latest.pdfUrl) {
          setPdfViewport(null);
          setPdfUrl(latest.pdfUrl);
          setPdfCompiledAt(latest.pdfCompiledAt);
          setPreviewTab("pdf");
          void loadArtifacts();
        } else if (compileState.status === "failed") {
          setPreviewTab(classifyCompileLog(latest.latestRun.log, "failed").errors.length ? "errors" : "log");
        }
      }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [compileState?.runId, compileState?.status, projectId]);

  useEffect(() => {
    if (!project) return;
    collaboration.setPermission(project.permission);
  }, [collaboration, project?.permission]);

  useEffect(() => {
    if (!filesEvent) return;
    if (filesEvent.kind === "move" && filesEvent.source && filesEvent.destination) {
      const source = filesEvent.source;
      const destination = filesEvent.destination;
      const remap = (value: string) => value === source
        ? destination
        : value.startsWith(`${source}/`) ? `${destination}${value.slice(source.length)}` : value;
      setActiveFile((current) => remap(current));
      setSelectedFolder((current) => current ? remap(current) : current);
    }
    void Promise.all([
      api<{ files: FileEntry[] }>(`/api/projects/${projectId}/files`),
      api<{ project: Project }>(`/api/projects/${projectId}`)
    ]).then(([fileResult, projectResult]) => {
      setFiles(fileResult.files);
      setProject(projectResult.project);
      void loadCompletionIndex();
    }).catch(() => undefined);
  }, [filesEvent?.revision]);

  useEffect(() => {
    if (!activeFile) return;
    collaboration.setActiveFile(activeFile);
    setDirty(false); setLoadedFile(""); setSaveState("editor.loading");
    const sharedText = collaboration.getText(activeFile);
    const updateContent = (_event?: unknown, transaction?: { local: boolean }) => {
      updateEditorContent(sharedText.toString());
      setLoadedFile(activeFile);
      if (transaction?.local && project?.permission !== "read") {
        setDirty(true);
        setSaveState("editor.pending");
      } else {
        setSaveState("editor.saved");
      }
    };
    sharedText.observe(updateContent);
    if (collaborationSynced) updateContent();
    void loadComments(activeFile);
    return () => sharedText.unobserve(updateContent);
  }, [activeFile, collaboration, collaborationSynced, project?.permission]);

  useEffect(() => {
    if (activeFile && commentsRevision) void loadComments(activeFile);
  }, [commentsRevision]);

  useEffect(() => {
    if (!dirty || !activeFile) return;
    setSaveState("editor.pending");
    const timer = window.setTimeout(() => {
      setDirty(false);
      setSaveState("editor.saved");
    }, 600);
    return () => window.clearTimeout(timer);
  }, [content, dirty, activeFile]);

  const save = async (): Promise<boolean> => {
    if (!project || project.permission === "read" || !activeFile) return false;
    setSaveState("editor.saving");
    try {
      await collaboration.flush();
      void loadCompletionIndex();
      setDirty(false); setSaveState("editor.saved");
      return true;
    } catch {
      setSaveState("editor.saveFailed"); setError(t("errors.collaborationUnavailable")); return false;
    }
  };
  async function loadComments(file: string) {
    try {
      const result = await api<{ comments: Comment[] }>(`/api/projects/${projectId}/comments?path=${encodeURIComponent(file)}`);
      setComments(result.comments);
    } catch { setComments([]); }
  }
  const compile = async () => {
    if (!project || project.permission === "read" || compiling
      || compileState?.status === "queued" || compileState?.status === "running") return;
    setCompiling(true); setError(""); setNotice(""); setCompileLog(""); setCompileOutcome(null); setPreviewTab(pdfUrl ? "pdf" : "log");
    try {
      if (!(await save())) return;
      const result = await api<{ ok: boolean; skipped?: boolean; log: string; pdfUrl: string | null; pdfCompiledAt: string | null }>(`/api/projects/${projectId}/compile`, { method: "POST" });
      setCompileLog(result.log);
      setCompileOutcome(result.ok ? "succeeded" : "failed");
      if (result.skipped) setNotice(t("editor.upToDate"));
      if (result.pdfUrl) { setPdfViewport(null); setPdfUrl(result.pdfUrl); setPdfCompiledAt(result.pdfCompiledAt); setPreviewTab("pdf"); }
      else setPreviewTab(classifyCompileLog(result.log, "failed").errors.length ? "errors" : "log");
    } catch (e) { setError(errorMessage(e)); }
    finally { setCompiling(false); }
  };
  compileAction.current = () => void compile();
  useEffect(() => {
    const handleCompileShortcut = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLocaleLowerCase() !== "s") return;
      event.preventDefault(); event.stopPropagation();
      if (!event.repeat) compileAction.current();
    };
    window.addEventListener("keydown", handleCompileShortcut, true);
    return () => window.removeEventListener("keydown", handleCompileShortcut, true);
  }, []);
  const updateEditorPreferences = (next: EditorPreferences) => {
    setEditorPreferences(next); saveEditorPreferences(next);
  };
  const createFile = async () => {
    if (!newFilePath.trim() || newFilePath.trim().endsWith("/")) return;
    try {
      await api(`/api/projects/${projectId}/file`, { method: "PUT", body: JSON.stringify({ path: newFilePath, content: "" }) });
      await loadFiles(); setActiveFile(newFilePath);
      setExpandedFolders((current) => new Set([...current, ...parentFolders(newFilePath)]));
      setNewFileOpen(false); setNewFilePath("");
    } catch (e) { setError(errorMessage(e)); }
  };
  const createFolder = async () => {
    if (!newFolderName.trim()) return;
    const folderPath = selectedFolder ? `${selectedFolder}/${newFolderName.trim()}` : newFolderName.trim();
    try {
      const result = await api<{ path: string }>(`/api/projects/${projectId}/folders`, {
        method: "POST", body: JSON.stringify({ path: folderPath })
      });
      await loadFiles();
      setExpandedFolders((current) => new Set([...current, ...parentFolders(result.path), result.path]));
      setSelectedFolder(result.path); setNewFolderOpen(false); setNewFolderName("");
    } catch (e) { setError(errorMessage(e)); }
  };
  const uploadFiles = async (filesToUpload: File[]) => {
    if (!filesToUpload.length) return;
    const maxSize = site.maxUploadSizeMB ?? 50;
    const oversized = filesToUpload.find((file) => file.size > maxSize * 1024 * 1024);
    if (oversized) return setError(t("errors.fileTooLarge", { size: maxSize }));
    try {
      const destination = selectedFolder ? `?directory=${encodeURIComponent(selectedFolder)}` : "";
      let lastTextPath = "";
      for (const file of filesToUpload) {
        const data = new FormData();
        data.append("file", file);
        const response = await fetch(`/api/projects/${projectId}/upload${destination}`, { method: "POST", body: data });
        const result = await response.json();
        if (!response.ok) throw new Error(localizedResponseError(result, response.status, "errors.upload"));
        if (isEditableTextFile(result.path)) lastTextPath = result.path;
      }
      await loadFiles();
      if (lastTextPath) setActiveFile(lastTextPath);
    } catch (e) { setError(errorMessage(e)); }
  };
  const upload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    await uploadFiles(Array.from(event.target.files ?? []));
    event.target.value = "";
  };
  const viewArtifact = async (artifact: CompileArtifact) => {
    if (!artifact.viewable) return;
    setArtifactLoading(true);
    try {
      const result = await api<{ path: string; content: string }>(`/api/projects/${projectId}/compile/artifacts?path=${encodeURIComponent(artifact.path)}`);
      setArtifactPreview(result);
    } catch (e) { setError(errorMessage(e)); }
    finally { setArtifactLoading(false); }
  };
  const previewFile = async (entry: FileEntry) => {
    setResourcePreviewLoading(false);
    const url = rawFileUrl(projectId, entry.path);
    if ((entry.size ?? 0) > MAX_DIRECT_RESOURCE_PREVIEW_BYTES) {
      setResourcePreview({ path: entry.path, kind: "large", size: entry.size ?? 0, url });
      return;
    }
    const kind = resourcePreviewKind(entry.path);
    if (kind !== "text") {
      setResourcePreview({ path: entry.path, kind, size: entry.size ?? 0, url });
      return;
    }
    setResourcePreview({ path: entry.path, kind, size: entry.size ?? 0, url, content: "" });
    setResourcePreviewLoading(true);
    try {
      const response = await fetch(url);
      const text = await response.text();
      if (!response.ok) throw new Error(text || t("errors.request", { status: response.status }));
      setResourcePreview((current) => current?.path === entry.path ? { ...current, content: text } : current);
    } catch (e) {
      setResourcePreview(null);
      setError(errorMessage(e));
    } finally {
      setResourcePreviewLoading(false);
    }
  };
  const openFile = (entry: FileEntry) => {
    const kind = resourcePreviewKind(entry.path);
    if ((entry.size ?? 0) > MAX_DIRECT_RESOURCE_PREVIEW_BYTES || kind !== "text" || !isEditableTextFile(entry.path)) void previewFile(entry);
    else setActiveFile(entry.path);
  };
  const movePath = async () => {
    if (!moveEntry) return;
    try {
      if (!(await save())) return;
      const result = await api<{ path: string }>(`/api/projects/${projectId}/path`, {
        method: "PATCH", body: JSON.stringify({ source: moveEntry.path, destinationDirectory: moveDestination })
      });
      const remap = (value: string) => value === moveEntry.path
        ? result.path
        : value.startsWith(`${moveEntry.path}/`) ? `${result.path}${value.slice(moveEntry.path.length)}` : value;
      setActiveFile((current) => remap(current));
      setSelectedFolder((current) => current ? remap(current) : current);
      const [fileResult, projectResult] = await Promise.all([
        api<{ files: FileEntry[] }>(`/api/projects/${projectId}/files`),
        api<{ project: Project }>(`/api/projects/${projectId}`)
      ]);
      setFiles(fileResult.files); setProject(projectResult.project);
      setExpandedFolders((current) => new Set([...current, ...parentFolders(result.path), moveDestination].filter(Boolean)));
      setMoveEntry(null); setMoveDestination("");
    } catch (e) { setError(errorMessage(e)); }
  };
  const toggleFilesPanel = () => {
    if (filesPanel.current?.isCollapsed()) filesPanel.current.expand();
    else filesPanel.current?.collapse();
  };
  const addComment = async () => {
    if (!commentText.trim()) return;
    try {
      if (project?.permission !== "read" && !(await save())) return;
      await api(`/api/projects/${projectId}/comments`, { method: "POST", body: JSON.stringify({ path: activeFile, content: commentText, ...selection }) });
      await loadComments(activeFile); setSidePanel("comments"); setCommentOpen(false); setCommentText("");
    } catch (e) { setError(errorMessage(e)); }
  };
  const toggleComment = async (comment: Comment) => {
    try {
      await api(`/api/projects/${projectId}/comments/${comment.id}`, {
        method: "PATCH",
        body: JSON.stringify({ resolved: !Boolean(comment.resolved) })
      });
      await loadComments(activeFile);
    } catch (e) { setError(errorMessage(e)); }
  };
  const replyToComment = async (comment: Comment, replyContent: string): Promise<boolean> => {
    try {
      await api(`/api/projects/${projectId}/comments/${comment.id}/replies`, {
        method: "POST", body: JSON.stringify({ content: replyContent })
      });
      await loadComments(activeFile);
      return true;
    } catch (e) { setError(errorMessage(e)); return false; }
  };
  const editComment = async (comment: Comment, content: string): Promise<boolean> => {
    try {
      await api(`/api/projects/${projectId}/comments/${comment.id}`, {
        method: "PATCH", body: JSON.stringify({ content })
      });
      await loadComments(activeFile);
      return true;
    } catch (e) { setError(errorMessage(e)); return false; }
  };
  const deleteComment = async (comment: Comment): Promise<boolean> => {
    try {
      await api(`/api/projects/${projectId}/comments/${comment.id}`, { method: "DELETE" });
      await loadComments(activeFile);
      setFocusComment((current) => current?.id === comment.id ? null : current);
      return true;
    } catch (e) { setError(errorMessage(e)); return false; }
  };
  const editCommentReply = async (comment: Comment, replyId: string, content: string): Promise<boolean> => {
    try {
      await api(`/api/projects/${projectId}/comments/${comment.id}/replies/${replyId}`, {
        method: "PATCH", body: JSON.stringify({ content })
      });
      await loadComments(activeFile);
      return true;
    } catch (e) { setError(errorMessage(e)); return false; }
  };
  const deleteCommentReply = async (comment: Comment, replyId: string): Promise<boolean> => {
    try {
      await api(`/api/projects/${projectId}/comments/${comment.id}/replies/${replyId}`, { method: "DELETE" });
      await loadComments(activeFile);
      return true;
    } catch (e) { setError(errorMessage(e)); return false; }
  };
  const jumpToSource = (path: string, line: number, column: number) => {
    const jump = { path, line, column, nonce: ++syncNonce.current };
    setSourceJump(jump);
    if (activeFile !== path) setActiveFile(path);
  };
  const syncSourceToPdf = async (path: string, line: number, column: number) => {
    try {
      const location = await api<{ page: number; x: number; y: number }>(
        `/api/projects/${projectId}/sync/pdf?path=${encodeURIComponent(path)}&line=${line}&column=${column}`
      );
      setPdfTarget({ ...location, nonce: ++syncNonce.current });
      setPreviewTab("pdf");
    } catch (e) { setError(errorMessage(e)); }
  };
  const syncPdfToSource = async (page: number, x: number, y: number) => {
    try {
      const location = await api<{ path: string; line: number; column: number }>(
        `/api/projects/${projectId}/sync/source?page=${page}&x=${x}&y=${y}`
      );
      jumpToSource(location.path, location.line, location.column);
    } catch (e) { setError(errorMessage(e)); }
  };
  const syncVisiblePdfToSource = () => {
    if (pdfViewport) void syncPdfToSource(pdfViewport.page, pdfViewport.x, pdfViewport.y);
  };

  const outline = useMemo(() => parseOutline(content), [content]);
  const compileMessages = useMemo(() => classifyCompileLog(compileLog, compileOutcome), [compileLog, compileOutcome]);
  const spellCheckSummary = useMemo(() => {
    if (spellCheckFile !== activeFile || spellCheckSource !== content) return null;
    return {
      total: spellCheckIssues.length,
      unique: new Set(spellCheckIssues.map((issue) => issue.word.toLocaleLowerCase("en-US"))).size
    };
  }, [spellCheckFile, activeFile, spellCheckSource, content, spellCheckIssues]);
  const showEditor = workspaceLayout !== "pdf-only";
  const showPreview = workspaceLayout !== "editor-only";
  const changeWorkspaceLayout = (next: WorkspaceLayout) => {
    setWorkspaceLayout(next);
    if (next === "pdf-only") setPreviewTab("pdf");
    try { window.localStorage.setItem(WORKSPACE_LAYOUT_KEY, next); } catch { /* Keep the in-memory choice. */ }
  };
  const directoryEntries = files.filter((entry) => entry.type === "directory");
  const visibleEntries = files.filter((entry) => parentFolders(entry.path).every((folder) => expandedFolders.has(folder)));
  if (!project) return <div className="center-card">{error || t("common.loading")}</div>;
  const readOnly = project.permission === "read";
  const sharedCompiling = compileState?.status === "queued" || compileState?.status === "running";
  const compileBusy = compiling || sharedCompiling;
  const collaborativeText = activeFile ? collaboration.getText(activeFile) : null;
  const pdfCompiledLabel = pdfCompiledAt ? new Date(pdfCompiledAt).toLocaleString(i18n.resolvedLanguage, {
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit"
  }) : "";

  return <div className="workspace">
    <header className="editor-topbar">
      <button className="back" title={t("editor.backToProjects")} aria-label={t("editor.backToProjects")} onClick={onBack}><ArrowLeft size={18} /></button><SiteLogo siteName={site.siteName} compact />
      <div className="project-heading"><strong>{project.name}</strong><small>{activeFile} · {t(saveState)}</small></div>
      <CollaborationPresence sessions={activeSessions} status={collaborationStatus} />
      <div className="editor-actions">{showEditor && <button className={!filesCollapsed ? "active" : ""} onClick={toggleFilesPanel}>{filesCollapsed ? <PanelLeftOpen size={15} /> : <PanelLeftClose size={15} />}{t("common.files")}</button>}<WorkspaceLayoutMenu value={workspaceLayout} onChange={changeWorkspaceLayout} /><button onClick={() => setShareOpen(true)}><Users size={15} />{t("projectSettings.share")}</button>{project.ownerId === user.id && <button onClick={() => setGitOpen(true)}><GitBranch size={15} />Git</button>}<button onClick={() => setCommentOpen(true)} disabled={!activeFile}><MessageSquarePlus size={15} />{t("editor.addComment")}</button><button className={sidePanel === "comments" ? "active" : ""} onClick={() => setSidePanel(sidePanel === "comments" ? null : "comments")}><MessageSquare size={15} />{t("common.comments")} {comments.filter((item) => !item.resolved).length || ""}</button><button className={sidePanel === "settings" ? "active" : ""} onClick={() => setSidePanel(sidePanel === "settings" ? null : "settings")}><Settings size={15} />{t("common.settings")}</button><button className="compile" title={sharedCompiling ? t("editor.compilingBy", { name: compileState?.requestedBy.name ?? "" }) : t("editor.compileShortcut")} onClick={compile} disabled={compileBusy || readOnly || !collaborationSynced}>{compileBusy ? <LoaderCircle className="spin" size={15} /> : <Play size={15} />}{sharedCompiling ? t("editor.compilingBy", { name: compileState?.requestedBy.name ?? "" }) : compiling ? t("editor.compiling") : t("editor.compile", { engine: project.engine })}</button></div>
    </header>
    {error && <div className="toast" onClick={() => setError("")}>{error}</div>}
    {notice && <div className="toast success" onClick={() => setNotice("")}>{notice}</div>}
    <PanelGroup autoSaveId="texlite-workspace-layout" direction="horizontal" className="work-grid">
      {showEditor && <Panel id="files" order={1} ref={filesPanel} defaultSize={16} minSize={12} maxSize={30} collapsible collapsedSize={0} onCollapse={() => setFilesCollapsed(true)} onExpand={() => setFilesCollapsed(false)}>
        <aside className="left-panel"><section className={`files-panel${fileDragActive ? " drop-active" : ""}`} onDragEnter={(event) => { if (!event.dataTransfer.types.includes("Files")) return; event.preventDefault(); if (!readOnly) setFileDragActive(true); }} onDragOver={(event) => { if (!event.dataTransfer.types.includes("Files")) return; event.preventDefault(); event.dataTransfer.dropEffect = readOnly ? "none" : "copy"; }} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFileDragActive(false); }} onDrop={(event) => { event.preventDefault(); setFileDragActive(false); if (!readOnly) void uploadFiles(Array.from(event.dataTransfer.files)); }}><div className="panel-title"><span><FileText size={14} />{t("common.files")}</span><span className="file-tools">{!readOnly && <><button aria-label={t("editor.uploadAttachment")} title={t("editor.uploadTo", { folder: selectedFolder || t("editor.projectRoot") })} onClick={() => uploadInput.current?.click()}><Upload size={15} /></button><button aria-label={t("editor.newFolder")} title={t("editor.newFolder")} onClick={() => { setNewFolderName(""); setNewFolderOpen(true); }}><FolderPlus size={15} /></button><button aria-label={t("editor.newFile")} title={t("editor.newFile")} onClick={() => { setNewFilePath(selectedFolder ? `${selectedFolder}/` : ""); setNewFileOpen(true); }}><FilePlus2 size={15} /></button><input ref={uploadInput} type="file" multiple hidden onChange={(event) => void upload(event)} /></>}<button aria-label={t("editor.collapseFiles")} title={t("editor.collapseFiles")} onClick={toggleFilesPanel}><PanelLeftClose size={15} /></button></span></div>
          {fileDragActive && <div className="file-drop-overlay"><Upload size={24} /><strong>{t("editor.dropFiles")}</strong><span>{t("editor.uploadTo", { folder: selectedFolder || t("editor.projectRoot") })}</span></div>}
          <div className="folder-target" title={selectedFolder || t("editor.projectRoot")}><FolderOpen size={13} /><span>{selectedFolder || t("editor.projectRoot")}</span></div>
          <div className="file-list" style={{ fontSize: `${editorPreferences.fontSize}px` }}><div className={`file-entry folder-entry root-entry${selectedFolder === "" ? " selected" : ""}`}><button className="file-entry-main" onClick={() => setSelectedFolder("")}><FolderOpen size={15} /><span>{t("editor.projectRoot")}</span></button></div>{visibleEntries.map((entry) => {
            const depth = entry.path.split("/").length - 1;
            const name = entry.path.split("/").at(-1);
            const expanded = expandedFolders.has(entry.path);
            if (entry.type === "directory") return <div className={`file-entry folder-entry${selectedFolder === entry.path ? " selected" : ""}`} style={{ paddingLeft: `${depth * 13 + 5}px` }} key={entry.path}><button className="file-entry-main" title={entry.path} onClick={() => { setSelectedFolder(entry.path); setExpandedFolders((current) => { const next = new Set(current); if (next.has(entry.path)) next.delete(entry.path); else next.add(entry.path); return next; }); }}>{expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}<Folder size={14} /><span>{name}</span></button>{!readOnly && <button className="file-entry-action" title={t("editor.move")} aria-label={t("editor.move")} onClick={() => { setMoveEntry(entry); setMoveDestination(""); }}><Move size={13} /></button>}</div>;
            return <div className={`file-entry${activeFile === entry.path ? " active" : ""}`} style={{ paddingLeft: `${depth * 13 + 18}px` }} key={entry.path}><button className="file-entry-main" title={entry.path} onClick={() => openFile(entry)}><FileText size={13} /><span>{name}</span></button>{!readOnly && <button className="file-entry-action" title={t("editor.move")} aria-label={t("editor.move")} onClick={() => { setMoveEntry(entry); setMoveDestination(""); }}><Move size={13} /></button>}</div>;
          })}</div></section>
          <section className="outline-panel"><div className="panel-title"><span><ListTree size={14} />{t("common.outline")}</span></div><div className="outline">{outline.map((item, i) => <button className={`outline-item${sourceCursor.line === item.line ? " current" : ""}`} key={`${item.line}-${i}`} title={t("editor.outlineJump", { line: item.line })} onClick={() => { jumpToSource(activeFile, item.line, 1); void syncSourceToPdf(activeFile, item.line, 1); }}><span className="outline-guides" aria-hidden style={{ width: `${item.level * 12}px` }} /><small>{item.line}</small><span className="outline-title">{item.title}</span></button>)}{outline.length === 0 && <p className="muted padded">{t("editor.noOutline")}</p>}</div></section>
        </aside>
      </Panel>}
      {showEditor && <PanelResizeHandle className="resize-handle"><GripVertical size={12} /></PanelResizeHandle>}
      {showEditor && <Panel id="source" order={2} defaultSize={42} minSize={22}>
        <main className="source-panel"><LatexEditor key={activeFile} value={content} readOnly={readOnly} comments={comments} focusComment={focusComment} preferences={editorPreferences} completionIndex={completionIndex} spellCheckWords={dictionaryWords} spellCheckIssues={spellCheckFile === activeFile && spellCheckSource === content ? spellCheckIssues : []} jumpTo={loadedFile === activeFile && sourceJump?.path === activeFile ? sourceJump : null} searchRequest={0} collaboration={collaborativeText ? { text: collaborativeText, awareness: collaboration.awareness } : undefined} onChange={updateEditorContent} onSelection={(selectedText, startOffset, endOffset) => setSelection({ selectedText, startOffset, endOffset })} onCommentClick={(id) => { const comment = comments.find((item) => item.id === id); if (comment) { setFocusComment({ ...comment }); setSidePanel("comments"); } }} onCursor={(line, column) => setSourceCursor({ line, column })} /></main>
      </Panel>}
      {showEditor && showPreview && <PanelResizeHandle className="resize-handle sync-resize-handle"><GripVertical className="resize-grip" size={12} /><span className="sync-direction-buttons" onPointerDown={(event) => event.stopPropagation()}><button disabled={!pdfViewport} title={t("editor.showInSource")} aria-label={t("editor.showInSource")} onClick={syncVisiblePdfToSource}><span aria-hidden>←</span></button><button disabled={!activeFile || !pdfUrl} title={t("editor.showInPdf")} aria-label={t("editor.showInPdf")} onClick={() => void syncSourceToPdf(activeFile, sourceCursor.line, sourceCursor.column)}><span aria-hidden>→</span></button></span></PanelResizeHandle>}
      {showPreview && <Panel id="preview" order={3} defaultSize={42} minSize={22}>
        <section className="preview-panel">
          <div className="preview-tabs" role="tablist" aria-label={t("editor.outputTabs")}>
            <button className={`pdf-tab${previewTab === "pdf" ? " active" : ""}`} onClick={() => setPreviewTab("pdf")} title={pdfCompiledAt ? t("editor.pdfCompiledAt", { time: new Date(pdfCompiledAt).toLocaleString(i18n.resolvedLanguage) }) : undefined}><FileText size={14} /><span className="pdf-tab-label">PDF{pdfCompiledLabel && <small>{pdfCompiledLabel}</small>}</span></button>
            <button className={previewTab === "log" ? "active" : ""} onClick={() => setPreviewTab("log")}><ScrollText size={14} />{t("editor.log")}</button>
            <button className={previewTab === "warnings" ? "active" : ""} onClick={() => setPreviewTab("warnings")}><AlertTriangle size={14} />{t("editor.warnings")}<span>{compileMessages.warnings.length}</span></button>
            <button className={previewTab === "errors" ? "active" : ""} onClick={() => setPreviewTab("errors")}><XCircle size={14} />{t("editor.errors")}<span>{compileMessages.errors.length}</span></button>
            <button className={previewTab === "artifacts" ? "active" : ""} onClick={() => setPreviewTab("artifacts")}><PackageOpen size={14} />{t("editor.artifacts")}<span>{artifacts.length}</span></button>
          </div>
          <div className={`preview-content preview-${previewTab}`}>
            {previewTab === "pdf" && (pdfUrl ? <Suspense fallback={<div className="preview-empty"><span>{t("common.loading")}</span></div>}><PdfPreview url={pdfUrl} target={pdfTarget} compiling={compileBusy} onViewportLocation={(page, x, y) => setPdfViewport({ page, x, y })} /></Suspense> : <div className="preview-empty"><FileText size={28} /><strong>{t("editor.preview")}</strong><span>{t("editor.previewHint")}</span></div>)}
            {previewTab === "log" && <CompileOutput lines={compileLog ? compileLog.split("\n") : []} empty={compiling ? t("editor.compiling") : t("editor.noLog")} />}
            {previewTab === "warnings" && <CompileOutput tone="warning" lines={compileMessages.warnings} empty={t("editor.noWarnings")} />}
            {previewTab === "errors" && <CompileOutput tone="error" lines={compileMessages.errors} empty={t("editor.noErrors")} />}
            {previewTab === "artifacts" && <CompileArtifacts projectId={projectId} artifacts={artifacts} preview={artifactPreview} loading={artifactLoading} onView={(artifact) => void viewArtifact(artifact)} />}
          </div>
        </section>
      </Panel>}
      {sidePanel && <><PanelResizeHandle className="resize-handle"><GripVertical size={12} /></PanelResizeHandle><Panel id="context" order={4} defaultSize={20} minSize={15} maxSize={38}><aside className="context-panel"><div className="drawer-title"><strong>{sidePanel === "comments" ? t("editor.sourceComments") : t("editor.projectSettings")}</strong><button aria-label={t("common.close")} onClick={() => setSidePanel(null)}><X size={17} /></button></div>
          {sidePanel === "comments" && <div className="comments">{comments.map((comment) => <CommentThread key={comment.id} comment={comment} currentUserId={user.id} onFocus={() => setFocusComment({ ...comment })} onToggle={() => void toggleComment(comment)} onReply={(content) => replyToComment(comment, content)} onEdit={(content) => editComment(comment, content)} onDelete={() => deleteComment(comment)} onEditReply={(replyId, content) => editCommentReply(comment, replyId, content)} onDeleteReply={(replyId) => deleteCommentReply(comment, replyId)} />)}{comments.length === 0 && <p className="muted padded">{t("editor.noComments")}</p>}</div>}
          {sidePanel === "settings" && <ProjectSettings project={project} projectId={projectId} site={site} files={files} dictionaryWords={dictionaryWords} onDictionaryChange={setDictionaryWords} editorPreferences={editorPreferences} onEditorPreferences={updateEditorPreferences} spellCheckCount={spellCheckSummary?.total ?? null} spellCheckUniqueCount={spellCheckSummary?.unique ?? null} onProject={setProject} />}
        </aside></Panel></>}
    </PanelGroup>
    <Modal open={Boolean(resourcePreview)} extraWide={resourcePreview?.kind === "image" || resourcePreview?.kind === "pdf" || resourcePreview?.kind === "text"} title={resourcePreview?.path ?? ""} description={resourcePreview?.kind === "large" ? t("editor.resourceTooLarge", { size: formatFileSize(resourcePreview.size), limit: "10 MB" }) : t(`editor.resourcePreview.${resourcePreview?.kind ?? "text"}`)} onOpenChange={(open) => { if (!open) { setResourcePreview(null); setResourcePreviewLoading(false); } }} footer={resourcePreview && <a className="primary resource-download" href={`${resourcePreview.url}&download=1`} download><Download size={14} />{t("editor.downloadResource")}</a>}>
      {resourcePreview?.kind === "large" && <div className="resource-preview-message"><FileArchive size={34} /><strong>{t("editor.resourceTooLargeTitle")}</strong><span>{t("editor.resourceTooLargeDescription")}</span></div>}
      {resourcePreview?.kind === "unsupported" && <div className="resource-preview-message"><FileArchive size={34} /><strong>{t("editor.resourceUnsupportedTitle")}</strong><span>{t("editor.resourceUnsupportedDescription")}</span></div>}
      {resourcePreview?.kind === "image" && <div className="resource-image-wrap"><img className="resource-image" src={resourcePreview.url} alt={resourcePreview.path} /></div>}
      {resourcePreview?.kind === "pdf" && <iframe className="resource-pdf" src={resourcePreview.url} title={resourcePreview.path} />}
      {resourcePreview?.kind === "text" && (resourcePreviewLoading ? <div className="resource-preview-message"><LoaderCircle className="spin" size={24} /><span>{t("common.loading")}</span></div> : <pre className="resource-text">{resourcePreview.content}</pre>)}
    </Modal>
    <Modal open={newFileOpen} title={t("editor.newFile")} description={t("editor.newFileDescription")} onOpenChange={setNewFileOpen} footer={<><button onClick={() => setNewFileOpen(false)}>{t("common.cancel")}</button><button className="primary" onClick={() => void createFile()}>{t("common.create")}</button></>}><label className="form-field">{t("editor.filePath")}<input autoFocus value={newFilePath} onChange={(event) => setNewFilePath(event.target.value)} /></label></Modal>
    <Modal open={newFolderOpen} title={t("editor.newFolder")} description={t("editor.folderDestination", { folder: selectedFolder || t("editor.projectRoot") })} onOpenChange={setNewFolderOpen} footer={<><button onClick={() => setNewFolderOpen(false)}>{t("common.cancel")}</button><button className="primary" onClick={() => void createFolder()}>{t("common.create")}</button></>}><label className="form-field">{t("editor.folderName")}<input autoFocus value={newFolderName} onChange={(event) => setNewFolderName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void createFolder(); }} /></label></Modal>
    <Modal open={Boolean(moveEntry)} title={t("editor.moveTitle", { name: moveEntry?.path.split("/").at(-1) ?? "" })} description={t("editor.moveDescription")} onOpenChange={(open) => { if (!open) setMoveEntry(null); }} footer={<><button onClick={() => setMoveEntry(null)}>{t("common.cancel")}</button><button className="primary" onClick={() => void movePath()}>{t("editor.move")}</button></>}><label className="form-field">{t("editor.destinationFolder")}<select value={moveDestination} onChange={(event) => setMoveDestination(event.target.value)}><option value="">{t("editor.projectRoot")}</option>{directoryEntries.filter((directory) => moveEntry?.type !== "directory" || (directory.path !== moveEntry.path && !directory.path.startsWith(`${moveEntry.path}/`))).map((directory) => <option value={directory.path} key={directory.path}>{directory.path}</option>)}</select></label></Modal>
    <Modal open={commentOpen} title={t("editor.addComment")} description={selection.selectedText ? t("editor.commentDescription", { count: selection.endOffset - selection.startOffset }) : t("editor.pointComment")} onOpenChange={setCommentOpen} footer={<><button onClick={() => setCommentOpen(false)}>{t("common.cancel")}</button><button className="primary" onClick={() => void addComment()}>{t("editor.addComment")}</button></>}><label className="form-field">{t("editor.commentContent")}<textarea autoFocus rows={5} value={commentText} onChange={(event) => setCommentText(event.target.value)} /></label>{selection.selectedText && <blockquote className="selection-preview">{selection.selectedText}</blockquote>}</Modal>
    <ShareDialog open={shareOpen} onOpenChange={setShareOpen} project={project} projectId={projectId} />
    {project.ownerId === user.id && <GitDialog open={gitOpen} onOpenChange={setGitOpen} project={project} onBeforeMutation={save} />}
  </div>;
}

function CollaborationPresence({ sessions, status }: { sessions: ActiveSession[]; status: CollaborationStatus }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const overflowCount = Math.max(0, sessions.length - 5);
  const showAll = expanded && overflowCount > 0;
  const visibleSessions = showAll ? sessions : sessions.slice(0, 5);
  useEffect(() => {
    if (sessions.length <= 5) setExpanded(false);
  }, [sessions.length]);
  if (sessions.length <= 1) return null;
  return <div className={`collaboration-presence collaboration-${status}`} title={t(`editor.collaboration.${status}`)}>
    <span className="collaboration-status-dot" aria-label={t(`editor.collaboration.${status}`)} />
    {sessions.length > 1 && <div className="collaboration-avatars" aria-label={t("editor.collaboration.activeSessions", { count: sessions.length })}>
      {visibleSessions.map((session) => {
        const activity = session.editing ? t("editor.collaboration.editing") : t("editor.collaboration.viewing");
        const permission = session.permission === "read" ? t("common.readOnly") : t("common.readWrite");
        const title = t("editor.collaboration.sessionTooltip", {
          name: session.name, username: session.username, file: session.filePath || t("editor.collaboration.joining"), activity, permission
        });
        return <span
          className={`collaboration-avatar${session.editing ? " editing" : ""}${session.local ? " local" : ""}`}
          style={{ "--session-color": session.color } as React.CSSProperties}
          title={title}
          aria-label={title}
          tabIndex={0}
          key={session.clientId}
        >{avatarInitial(session.name, session.username)}<span className="collaboration-avatar-tooltip" role="tooltip"><strong>{session.name}</strong><span>@{session.username}</span><small>{session.filePath || t("editor.collaboration.joining")} · {activity} · {permission}</small></span></span>;
      })}
      {overflowCount > 0 && <button
        type="button"
        className="collaboration-avatar collaboration-avatar-overflow"
        aria-expanded={showAll}
        aria-label={showAll ? t("editor.collaboration.showFewerSessions") : t("editor.collaboration.showMoreSessions", { count: overflowCount })}
        title={showAll ? t("editor.collaboration.showFewerSessions") : t("editor.collaboration.showMoreSessions", { count: overflowCount })}
        onClick={() => setExpanded((current) => !current)}
      >{showAll ? "−" : `+${overflowCount}`}</button>}
    </div>}
  </div>;
}

function WorkspaceLayoutMenu({ value, onChange }: { value: WorkspaceLayout; onChange: (value: WorkspaceLayout) => void }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const layouts = [
    { value: "editor-pdf" as const, icon: Columns2 },
    { value: "editor-only" as const, icon: PanelLeft },
    { value: "pdf-only" as const, icon: PanelRight }
  ];
  useEffect(() => {
    if (!open) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);
  return <div className="layout-menu" ref={root}>
    <button type="button" className={`layout-trigger${open ? " active" : ""}`} aria-haspopup="menu" aria-expanded={open} title={t("editor.layout.current", { layout: t(`editor.layout.${value}.name`) })} onClick={() => setOpen((current) => !current)}>
      <Columns2 size={15} /><span><small>{t("editor.layout.label")}</small>{t(`editor.layout.${value}.name`)}</span><ChevronDown size={13} />
    </button>
    {open && <div className="layout-popover" role="menu" aria-label={t("editor.layout.label")}>
      <div className="layout-popover-title">{t("editor.layout.choose")}</div>
      {layouts.map((layout) => {
        const Icon = layout.icon;
        const selected = layout.value === value;
        return <button type="button" role="menuitemradio" aria-checked={selected} className={`layout-option${selected ? " selected" : ""}`} key={layout.value} onClick={() => { onChange(layout.value); setOpen(false); }}>
          <Icon size={19} /><span><strong>{t(`editor.layout.${layout.value}.name`)}</strong><small>{t(`editor.layout.${layout.value}.description`)}</small></span>{selected && <Check size={16} />}
        </button>;
      })}
    </div>}
  </div>;
}

function CommentThread({ comment, currentUserId, onFocus, onToggle, onReply, onEdit, onDelete, onEditReply, onDeleteReply }: {
  comment: Comment;
  currentUserId: string;
  onFocus: () => void;
  onToggle: () => void;
  onReply: (content: string) => Promise<boolean>;
  onEdit: (content: string) => Promise<boolean>;
  onDelete: () => Promise<boolean>;
  onEditReply: (replyId: string, content: string) => Promise<boolean>;
  onDeleteReply: (replyId: string) => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const [replying, setReplying] = useState(false);
  const [replyContent, setReplyContent] = useState("");
  const [editingComment, setEditingComment] = useState(false);
  const [commentContent, setCommentContent] = useState(comment.content);
  const [deleteCommentOpen, setDeleteCommentOpen] = useState(false);
  const [editingReplyId, setEditingReplyId] = useState<string | null>(null);
  const [replyEditContent, setReplyEditContent] = useState("");
  const [deleteReplyId, setDeleteReplyId] = useState<string | null>(null);
  const submitReply = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!replyContent.trim()) return;
    if (await onReply(replyContent)) { setReplyContent(""); setReplying(false); }
  };
  const submitCommentEdit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!commentContent.trim()) return;
    if (await onEdit(commentContent)) setEditingComment(false);
  };
  const submitReplyEdit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!editingReplyId || !replyEditContent.trim()) return;
    if (await onEditReply(editingReplyId, replyEditContent)) setEditingReplyId(null);
  };
  const username = comment.authorUsername;
  const formatTime = (value: string) => new Date(value).toLocaleString(i18n.resolvedLanguage);
  return <><article className={`comment-thread${comment.resolved ? " resolved" : ""}${comment.orphaned ? " orphaned" : ""}`} onClick={onFocus}>
    <header className="comment-header"><span className="comment-author"><strong>{comment.authorDisplayName ?? username ?? t("editor.deletedUser")}</strong>{username && <small>@{username}</small>}</span><span className="comment-times"><time dateTime={comment.createdAt} title={new Date(comment.createdAt).toISOString()}>{formatTime(comment.createdAt)}</time>{comment.editedAt && <small>{t("editor.editedAt", { time: formatTime(comment.editedAt) })}</small>}</span></header>
    <div className="comment-location">{comment.orphaned ? t("editor.orphaned") : t("editor.line", { line: comment.startLine })}</div>
    {comment.selectedText && <blockquote>{comment.selectedText}</blockquote>}
    {editingComment ? <form className="comment-reply-form comment-edit-form" onSubmit={(event) => void submitCommentEdit(event)} onClick={(event) => event.stopPropagation()}><textarea autoFocus rows={4} value={commentContent} onChange={(event) => setCommentContent(event.target.value)} /><div><button type="button" onClick={() => setEditingComment(false)}>{t("common.cancel")}</button><button className="primary" type="submit" disabled={!commentContent.trim()}><Save size={13} />{t("editor.saveChanges")}</button></div></form> : <p>{comment.content}</p>}
    {comment.replies.length > 0 && <div className="comment-replies">{comment.replies.map((reply) => <div className="comment-reply" key={reply.id}><header><span className="comment-author"><strong>{reply.authorDisplayName ?? reply.authorUsername ?? t("editor.deletedUser")}</strong>{reply.authorUsername && <small>@{reply.authorUsername}</small>}</span><span className="comment-times"><time dateTime={reply.createdAt} title={new Date(reply.createdAt).toISOString()}>{formatTime(reply.createdAt)}</time>{reply.editedAt && <small>{t("editor.editedAt", { time: formatTime(reply.editedAt) })}</small>}</span></header>{editingReplyId === reply.id ? <form className="comment-reply-form comment-edit-form" onSubmit={(event) => void submitReplyEdit(event)} onClick={(event) => event.stopPropagation()}><textarea autoFocus rows={3} value={replyEditContent} onChange={(event) => setReplyEditContent(event.target.value)} /><div><button type="button" onClick={() => setEditingReplyId(null)}>{t("common.cancel")}</button><button className="primary" type="submit" disabled={!replyEditContent.trim()}><Save size={13} />{t("editor.saveChanges")}</button></div></form> : <p>{reply.content}</p>}{reply.authorId === currentUserId && editingReplyId !== reply.id && <div className="comment-owner-actions"><button title={t("editor.editReply")} aria-label={t("editor.editReply")} onClick={(event) => { event.stopPropagation(); setEditingReplyId(reply.id); setReplyEditContent(reply.content); }}><Pencil size={12} /></button><button className="danger-text" title={t("editor.deleteReply")} aria-label={t("editor.deleteReply")} onClick={(event) => { event.stopPropagation(); setDeleteReplyId(reply.id); }}><Trash2 size={12} /></button></div>}</div>)}</div>}
    <div className="comment-actions"><button className="resolve" onClick={(event) => { event.stopPropagation(); onToggle(); }}>{comment.resolved ? <RotateCcw size={13} /> : <CheckCircle2 size={13} />}{comment.resolved ? t("editor.reopen") : t("editor.resolve")}</button><button className="reply-action" onClick={(event) => { event.stopPropagation(); setReplying((current) => !current); }}><Reply size={13} />{t("editor.reply")}</button>{comment.authorId === currentUserId && !editingComment && <span className="comment-owner-actions"><button title={t("editor.editComment")} aria-label={t("editor.editComment")} onClick={(event) => { event.stopPropagation(); setCommentContent(comment.content); setEditingComment(true); }}><Pencil size={13} /></button><button className="danger-text" title={t("editor.deleteComment")} aria-label={t("editor.deleteComment")} onClick={(event) => { event.stopPropagation(); setDeleteCommentOpen(true); }}><Trash2 size={13} /></button></span>}</div>
    {replying && <form className="comment-reply-form" onSubmit={(event) => void submitReply(event)} onClick={(event) => event.stopPropagation()}><textarea autoFocus rows={3} value={replyContent} placeholder={t("editor.replyPlaceholder")} onChange={(event) => setReplyContent(event.target.value)} /><div><button type="button" onClick={() => { setReplying(false); setReplyContent(""); }}>{t("common.cancel")}</button><button className="primary" type="submit" disabled={!replyContent.trim()}><Send size={13} />{t("editor.sendReply")}</button></div></form>}
  </article><ConfirmDialog open={deleteCommentOpen} title={t("editor.deleteCommentTitle")} description={t("editor.deleteCommentDescription", { count: comment.replies.length })} confirmLabel={t("common.delete")} danger onCancel={() => setDeleteCommentOpen(false)} onConfirm={() => void onDelete().then((deleted) => { if (deleted) setDeleteCommentOpen(false); })} /><ConfirmDialog open={Boolean(deleteReplyId)} title={t("editor.deleteReplyTitle")} description={t("editor.deleteReplyDescription")} confirmLabel={t("common.delete")} danger onCancel={() => setDeleteReplyId(null)} onConfirm={() => { if (deleteReplyId) void onDeleteReply(deleteReplyId).then((deleted) => { if (deleted) setDeleteReplyId(null); }); }} /></>;
}

interface ShareMember { id: string; username: string; displayName?: string; permission: "read" | "edit" }

function ShareDialog({ open, onOpenChange, project, projectId }: {
  open: boolean; onOpenChange: (open: boolean) => void; project: Project; projectId: string;
}) {
  const { t } = useTranslation();
  const [members, setMembers] = useState<ShareMember[]>([]);
  const [users, setUsers] = useState<Array<{ id: string; username: string; displayName?: string }>>([]);
  const [userId, setUserId] = useState("");
  const [permission, setPermission] = useState<"read" | "edit">("read");
  const [removeTarget, setRemoveTarget] = useState<ShareMember | null>(null);
  const [error, setError] = useState("");
  const canManage = project.permission === "owner";
  const load = async () => {
    try {
      const [memberResult, userResult] = await Promise.all([
        api<{ members: ShareMember[] }>(`/api/projects/${projectId}/members`),
        api<{ users: Array<{ id: string; username: string; displayName?: string }> }>("/api/users")
      ]);
      setMembers(memberResult.members);
      setUsers(userResult.users.filter((candidate) => candidate.id !== project.ownerId));
    } catch (e) { setError(errorMessage(e)); }
  };
  useEffect(() => { if (open) void load(); }, [open, projectId]);
  const addMember = async () => {
    if (!userId) return;
    try {
      await api(`/api/projects/${projectId}/members/${userId}`, { method: "PUT", body: JSON.stringify({ permission }) });
      setUserId(""); setPermission("read"); await load();
    } catch (e) { setError(errorMessage(e)); }
  };
  const changePermission = async (member: ShareMember, next: "read" | "edit") => {
    try {
      await api(`/api/projects/${projectId}/members/${member.id}`, { method: "PUT", body: JSON.stringify({ permission: next }) });
      await load();
    } catch (e) { setError(errorMessage(e)); }
  };
  const removeMember = async () => {
    if (!removeTarget) return;
    try {
      await api(`/api/projects/${projectId}/members/${removeTarget.id}`, { method: "DELETE" });
      setRemoveTarget(null); await load();
    } catch (e) { setError(errorMessage(e)); }
  };
  const availableUsers = users.filter((candidate) => !members.some((member) => member.id === candidate.id));
  return <><Modal open={open} wide title={t("projectSettings.share")} description={t("projectSettings.shareDescription")} onOpenChange={onOpenChange} footer={<button onClick={() => onOpenChange(false)}>{t("common.close")}</button>}>
    <div className="share-dialog">
      {error && <p className="error">{error}</p>}
      <div className="share-owner"><Users size={17} /><span><small>{t("projects.owner")}</small><strong>{project.ownerDisplayName ?? project.ownerUsername}</strong></span></div>
      {canManage && <div className="share-add"><label className="form-field">{t("common.user")}<select value={userId} onChange={(event) => setUserId(event.target.value)}><option value="">{t("projectSettings.chooseUser")}</option>{availableUsers.map((candidate) => <option value={candidate.id} key={candidate.id}>{candidate.displayName ?? candidate.username}</option>)}</select></label><label className="form-field">{t("common.permission")}<select value={permission} onChange={(event) => setPermission(event.target.value as "read" | "edit")}><option value="read">{t("common.readOnly")}</option><option value="edit">{t("common.readWrite")}</option></select></label><button className="primary icon-button" disabled={!userId} onClick={() => void addMember()}><UserPlus size={15} />{t("projectSettings.addMember")}</button></div>}
      <div className="shared-members-heading"><strong>{t("projectSettings.members")}</strong><span>{members.length}</span></div>
      <div className="shared-members">{members.map((member) => <div className="shared-member" key={member.id}><span className="member-identity"><span className="member-avatar">{(member.displayName ?? member.username).slice(0, 1).toLocaleUpperCase()}</span><span><strong>{member.displayName ?? member.username}</strong><small>@{member.username}</small></span></span><span className="member-controls"><select aria-label={t("common.permission")} disabled={!canManage} value={member.permission} onChange={(event) => void changePermission(member, event.target.value as "read" | "edit")}><option value="read">{t("common.readOnly")}</option><option value="edit">{t("common.readWrite")}</option></select>{canManage && <button className="icon-only danger-text" title={t("common.remove")} aria-label={t("common.remove")} onClick={() => setRemoveTarget(member)}><Trash2 size={15} /></button>}</span></div>)}{members.length === 0 && <div className="share-empty"><Users size={24} /><span>{t("projectSettings.noMembers")}</span></div>}</div>
    </div>
  </Modal><ConfirmDialog open={Boolean(removeTarget)} title={t("projectSettings.removeTitle")} description={t("projectSettings.removeDescription", { username: removeTarget?.username ?? "" })} confirmLabel={t("common.remove")} danger onCancel={() => setRemoveTarget(null)} onConfirm={() => void removeMember()} /></>;
}

function ProjectSettings({ project, projectId, site, files, dictionaryWords, onDictionaryChange, editorPreferences, onEditorPreferences, spellCheckCount, spellCheckUniqueCount, onProject }: {
  project: Project; projectId: string; site: SiteConfig; files: FileEntry[]; dictionaryWords: string[];
  onDictionaryChange: (words: string[]) => void;
  editorPreferences: EditorPreferences; onEditorPreferences: (preferences: EditorPreferences) => void;
  spellCheckCount: number | null; spellCheckUniqueCount: number | null;
  onProject: (p: Project) => void;
}) {
  const { t } = useTranslation();
  const [engine, setEngine] = useState(project.engine);
  const [rcText, setRcText] = useState("");
  const [name, setName] = useState(project.name);
  const [mainFile, setMainFile] = useState(project.mainFile);
  const [error, setError] = useState("");
  const [dictionaryValue, setDictionaryValue] = useState("");
  const [dictionaryError, setDictionaryError] = useState("");
  const [settingsTab, setSettingsTab] = useState<"appearance" | "compiler">("appearance");
  const [appearancePreferences, setAppearancePreferences] = useState(editorPreferences);
  const canManage = project.permission === "owner";
  const canManageDictionary = project.permission !== "read";
  useEffect(() => setAppearancePreferences(editorPreferences), [editorPreferences]);
  useEffect(() => {
    if (!project.latexmkrc) return setRcText("");
    void api<{ content: string }>(`/api/projects/${projectId}/file?path=${encodeURIComponent(project.latexmkrc)}`)
      .then(({ content }) => setRcText(content)).catch((e) => setError(errorMessage(e)));
  }, [project.latexmkrc]);
  const texFiles = files.filter((entry) => entry.type === "file" && /\.tex$/i.test(entry.path)).map((entry) => entry.path);
  const mainFileOptions = [...new Set(project.mainFile.toLowerCase().endsWith(".tex") ? [...texFiles, project.mainFile] : texFiles)]
    .sort((left, right) => left.localeCompare(right));
  const saveCompilerSettings = async () => {
    try {
      const latexmkrc = rcText.trim() && site.allowProjectLatexmkrc !== false ? ".latexmkrc" : null;
      if (latexmkrc) await api(`/api/projects/${projectId}/file`, { method: "PUT", body: JSON.stringify({ path: latexmkrc, content: rcText }) });
      const result = await api<{ project: Project }>(`/api/projects/${projectId}`, {
        method: "PATCH", body: JSON.stringify({ name, mainFile, engine, latexmkrc })
      });
      onProject(result.project);
    } catch (e) { setError(errorMessage(e)); }
  };
  const saveAppearanceSettings = () => onEditorPreferences(appearancePreferences);
  const addDictionaryWord = async () => {
    const word = dictionaryValue.trim();
    if (!word) return;
    try {
      const result = await api<{ words: string[] }>(`/api/projects/${projectId}/dictionary`, {
        method: "POST", body: JSON.stringify({ word })
      });
      onDictionaryChange(result.words);
      setDictionaryValue("");
      setDictionaryError("");
    } catch (e) { setDictionaryError(errorMessage(e)); }
  };
  const removeDictionaryWord = async (word: string) => {
    try {
      const result = await api<{ words: string[] }>(`/api/projects/${projectId}/dictionary/${encodeURIComponent(word)}`, { method: "DELETE" });
      onDictionaryChange(result.words);
      setDictionaryError("");
    } catch (e) { setDictionaryError(errorMessage(e)); }
  };
  return <div className="settings padded">
    {error && <p className="error">{error}</p>}
    <div className="settings-tabs" role="tablist" aria-label={t("common.settings")}>
      <button id="settings-tab-appearance" type="button" role="tab" aria-selected={settingsTab === "appearance"} aria-controls="settings-panel-appearance" className={`settings-tab${settingsTab === "appearance" ? " active" : ""}`} onClick={() => setSettingsTab("appearance")}>
        <Type size={15} />{t("projectSettings.editorTab")}
      </button>
      <button id="settings-tab-compiler" type="button" role="tab" aria-selected={settingsTab === "compiler"} aria-controls="settings-panel-compiler" className={`settings-tab${settingsTab === "compiler" ? " active" : ""}`} onClick={() => setSettingsTab("compiler")}>
        <Settings size={15} />{t("projectSettings.compilerTab")}
      </button>
    </div>
    {settingsTab === "appearance" ? <section id="settings-panel-appearance" role="tabpanel" aria-labelledby="settings-tab-appearance">
      <div className="settings-section-title"><Type size={15} /><strong>{t("projectSettings.editorAppearance")}</strong></div>
      <p className="settings-description appearance-description">{t("projectSettings.editorAppearanceDescription")}</p>
      <label>{t("projectSettings.fontFamily")}<select value={appearancePreferences.font} onChange={(event) => setAppearancePreferences({ ...appearancePreferences, font: event.target.value as EditorPreferences["font"] })}>{editorFonts.map((font) => <option value={font.id} key={font.id}>{t(font.labelKey)}</option>)}</select></label>
      <label>{t("projectSettings.fontSize")}<select value={appearancePreferences.fontSize} onChange={(event) => setAppearancePreferences({ ...appearancePreferences, fontSize: Number(event.target.value) })}>{[12, 13, 14, 15, 16, 18, 20].map((size) => <option value={size} key={size}>{size} px</option>)}</select></label>
      <label>{t("projectSettings.lineHeight")}<select value={appearancePreferences.lineHeight} onChange={(event) => setAppearancePreferences({ ...appearancePreferences, lineHeight: Number(event.target.value) })}><option value={1.45}>{t("projectSettings.lineHeightCompact")}</option><option value={1.65}>{t("projectSettings.lineHeightNormal")}</option><option value={1.85}>{t("projectSettings.lineHeightRelaxed")}</option></select></label>
      <label className="editor-checkbox"><input type="checkbox" checked={appearancePreferences.lineWrapping} onChange={(event) => setAppearancePreferences({ ...appearancePreferences, lineWrapping: event.target.checked })} /><WrapText size={15} /><span>{t("projectSettings.lineWrapping")}</span></label>
      <label className="editor-checkbox"><input type="checkbox" checked={appearancePreferences.spellCheck} onChange={(event) => setAppearancePreferences({ ...appearancePreferences, spellCheck: event.target.checked })} /><span>{t("projectSettings.spellCheck")}</span></label>
      {spellCheckCount !== null && <div className={`spell-check-result${spellCheckCount ? " has-issues" : ""}`} role="status" aria-live="polite"><SpellCheck2 size={14} />{spellCheckCount ? t("projectSettings.spellingIssues", { count: spellCheckCount, uniqueCount: spellCheckUniqueCount ?? 0 }) : t("projectSettings.noSpellingIssues")}</div>}
      <div className="settings-section-title"><BookOpen size={15} /><strong>{t("projectSettings.dictionary")}</strong></div>
      <p className="settings-description">{t("projectSettings.dictionaryDescription")}</p>
      {dictionaryError && <p className="error dictionary-error">{dictionaryError}</p>}
      {canManageDictionary && <div className="dictionary-add"><input value={dictionaryValue} placeholder={t("projectSettings.dictionaryPlaceholder")} onChange={(event) => setDictionaryValue(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void addDictionaryWord(); } }} /><button type="button" disabled={!dictionaryValue.trim()} onClick={() => void addDictionaryWord()}>{t("projectSettings.addWord")}</button></div>}
      <div className="dictionary-words">{dictionaryWords.map((word) => <span className="dictionary-word" key={word}><code>{word}</code>{canManageDictionary && <button type="button" title={t("common.delete")} aria-label={`${t("common.delete")} ${word}`} onClick={() => void removeDictionaryWord(word)}><X size={13} /></button>}</span>)}{dictionaryWords.length === 0 && <span className="dictionary-empty">{t("projectSettings.dictionaryEmpty")}</span>}</div>
      <div className="settings-actions"><button className="settings-save" onClick={saveAppearanceSettings}><Save size={15} />{t("projectSettings.saveAppearance")}</button></div>
    </section> : <section id="settings-panel-compiler" role="tabpanel" aria-labelledby="settings-tab-compiler">
      <div className="settings-section-title"><Settings size={15} /><strong>{t("projectSettings.compilerTab")}</strong></div>
      <p className="settings-description compiler-description">{t("projectSettings.compilerDescription")}</p>
      <div className="settings-section-title project-configuration"><Settings size={15} /><strong>{t("projectSettings.projectConfiguration")}</strong></div>
      <label>{t("projects.name")}<input disabled={!canManage} value={name} onChange={(e) => setName(e.target.value)} /></label>
      <label>{t("projectSettings.mainFile")}<select disabled={!canManage || mainFileOptions.length === 0} value={mainFile} onChange={(e) => setMainFile(e.target.value)}>{mainFileOptions.map((filePath) => <option value={filePath} key={filePath}>{filePath}</option>)}</select></label>
      <label>{t("projectSettings.engine")}<select disabled={!canManage} value={engine} onChange={(e) => setEngine(e.target.value as Project["engine"])}>{(site.allowedEngines ?? ["pdflatex", "xelatex", "lualatex"]).map((item) => <option key={item}>{item}</option>)}</select></label>
      <label>{t("projectSettings.latexmkrc")}<textarea className="latexmkrc-editor" rows={10} spellCheck={false} disabled={!canManage || site.allowProjectLatexmkrc === false} value={rcText} placeholder={t("projectSettings.latexmkrcPlaceholder")} onChange={(e) => setRcText(e.target.value)} /></label>
      <div className="settings-actions">{canManage && <button className="settings-save" onClick={() => void saveCompilerSettings()}><Save size={15} />{t("projectSettings.saveCompiler")}</button>}</div>
    </section>}
  </div>;
}

function CompileOutput({ lines, empty, tone = "log" }: { lines: string[]; empty: string; tone?: "log" | "warning" | "error" }) {
  const Icon = tone === "error" ? XCircle : tone === "warning" ? AlertTriangle : ScrollText;
  if (!lines.length) return <div className={`compile-empty compile-${tone}`}><Icon size={26} /><span>{empty}</span></div>;
  return <pre className={`compile-output compile-${tone}`}>{lines.join("\n")}</pre>;
}

function CompileArtifacts({ projectId, artifacts, preview, loading, onView }: {
  projectId: string;
  artifacts: CompileArtifact[];
  preview: { path: string; content: string } | null;
  loading: boolean;
  onView: (artifact: CompileArtifact) => void;
}) {
  const { t } = useTranslation();
  const downloadUrl = (filePath: string) => `/api/projects/${projectId}/compile/artifacts?path=${encodeURIComponent(filePath)}&download=1`;
  if (!artifacts.length) return <div className="compile-empty"><PackageOpen size={26} /><span>{t("editor.noArtifacts")}</span></div>;
  return <div className="artifact-browser">
    <div className="artifact-list">
      {artifacts.map((artifact) => <div className={`artifact-row${preview?.path === artifact.path ? " active" : ""}`} key={artifact.path}>
        <button type="button" disabled={!artifact.viewable} title={artifact.viewable ? t("editor.viewArtifact") : t("editor.downloadToView")} onClick={() => onView(artifact)}>
          <FileText size={14} /><span><strong>{artifact.path}</strong><small>{formatFileSize(artifact.size)}</small></span>
        </button>
        <a href={downloadUrl(artifact.path)} title={t("editor.downloadArtifact")} aria-label={t("editor.downloadArtifact")}><Download size={14} /></a>
      </div>)}
    </div>
    <div className="artifact-preview">
      {loading ? <div className="compile-empty"><LoaderCircle className="spin" size={24} /><span>{t("common.loading")}</span></div>
        : preview ? <><header><strong>{preview.path}</strong><a href={downloadUrl(preview.path)}><Download size={13} />{t("projects.download")}</a></header><pre>{preview.content}</pre></>
          : <div className="compile-empty"><FileText size={24} /><span>{t("editor.selectArtifact")}</span></div>}
    </div>
  </div>;
}

function parentFolders(filePath: string): string[] {
  const parts = filePath.split("/").filter(Boolean);
  parts.pop();
  return parts.map((_part, index) => parts.slice(0, index + 1).join("/"));
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

const binaryFileExtensions = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".ico", ".avif", ".pdf", ".zip", ".gz", ".bz2", ".xz", ".tar", ".rar", ".7z",
  ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".odt", ".ods", ".odp", ".mp3", ".mp4", ".wav", ".ogg", ".webm", ".mov", ".avi",
  ".wasm", ".exe", ".bin", ".so", ".dll", ".class", ".jar"
]);

function isTextFile(filePath: string): boolean {
  const extension = `.${filePath.split(".").at(-1)?.toLocaleLowerCase() ?? ""}`;
  return !binaryFileExtensions.has(extension);
}

function isEditableTextFile(filePath: string): boolean {
  return /(?:\.(?:tex|bib|sty|cls|txt|md)|latexmkrc)$/i.test(filePath);
}

function resourcePreviewKind(filePath: string): ResourcePreviewKind {
  const extension = filePath.split(".").at(-1)?.toLocaleLowerCase() ?? "";
  if (extension === "pdf") return "pdf";
  if (["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif"].includes(extension)) return "image";
  if (isTextFile(filePath)) return "text";
  return "unsupported";
}

function rawFileUrl(projectId: string, filePath: string): string {
  return `/api/projects/${projectId}/file/raw?path=${encodeURIComponent(filePath)}`;
}

function isFilesEvent(value: unknown): value is FilesEvent {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<FilesEvent>;
  return (candidate.kind === "update" || candidate.kind === "move" || candidate.kind === "delete")
    && typeof candidate.revision === "string";
}
