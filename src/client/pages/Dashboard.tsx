import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../api";
import { ConfirmDialog, Modal } from "../Dialog";
import type { Project, ProjectListPagination, ProjectTag, SiteConfig, TagColor, User } from "../types";
import i18n from "../i18n";
import { errorMessage } from "../errors";
import { Activity, AlertTriangle, Archive, ArchiveRestore, ArrowDownUp, ArrowLeft, ArrowRightLeft, BookMarked, CalendarDays, ChevronLeft, ChevronRight, Copy, Download, FileArchive, FolderOpen, FolderPlus, History, LoaderCircle, MessageSquare, Pencil, Sparkles, Tags, Trash2, Upload, Users, X } from "lucide-react";
import { CitationLibraryDialog } from "../CitationLibraryDialog";
import { LanguageSwitcher } from "../LanguageSwitcher";
import { SiteFooter, SiteLogo } from "./SiteChrome";
import { AdminUsers } from "./AdminUsers";
import { ProjectListRow } from "./ProjectListRow";
import { TagManagementDialog } from "./TagManagementDialog";

const SystemMetricsDialog = lazy(() => import("../SystemMetricsDialog").then((module) => ({ default: module.SystemMetricsDialog })));

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function formatRelativeTime(
  value: string,
  locale: string,
  now: number,
  translate: (key: string, options: { days: number; hours: number; minutes: number }) => string
): string {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return value;

  const difference = timestamp - now;
  const absoluteDifference = Math.abs(difference);
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;
  const threeDays = 3 * day;
  if (absoluteDifference > threeDays) {
    const days = Math.floor(absoluteDifference / day);
    const direction = difference < 0 ? "Past" : "Future";
    return translate(`projects.relativeDays${direction}`, { days, hours: 0, minutes: 0 });
  }
  if (absoluteDifference >= day) {
    const days = Math.floor(absoluteDifference / day);
    const hours = Math.floor((absoluteDifference % day) / hour);
    const direction = difference < 0 ? "Past" : "Future";
    const unit = hours > 0 ? "DaysHours" : "Days";
    return translate(`projects.relative${unit}${direction}`, { days, hours, minutes: 0 });
  }
  if (absoluteDifference >= hour) {
    const hours = Math.floor(absoluteDifference / hour);
    const minutes = Math.floor((absoluteDifference % hour) / minute);
    const direction = difference < 0 ? "Past" : "Future";
    const unit = minutes > 0 ? "HoursMinutes" : "Hours";
    return translate(`projects.relative${unit}${direction}`, { days: 0, hours, minutes });
  }
  const unit: Intl.RelativeTimeFormatUnit = "minute";
  const unitLength = minute;
  const amount = Math.sign(difference) * Math.max(1, Math.floor(absoluteDifference / unitLength));
  return new Intl.RelativeTimeFormat(locale, { numeric: "always" }).format(amount, unit);
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
export function Dashboard({ site, user, initialData, onDataChange, onUser, onOpenProject }: {
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
  const [citationLibraryOpen, setCitationLibraryOpen] = useState(false);
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
  const importInput = useRef<HTMLInputElement>(null);
  const tagFilterSidebar = useRef<HTMLElement>(null);
  const [importing, setImporting] = useState(false);
  const [query, setQuery] = useState("");
  const [tagFilter, setTagFilter] = useState("");
  const [tagFiltersOpen, setTagFiltersOpen] = useState(false);
  const [tagManagerOpen, setTagManagerOpen] = useState(false);
  const [tagProject, setTagProject] = useState<Project | null>(null);
  const [renameProject, setRenameProject] = useState<Project | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [duplicateProject, setDuplicateProject] = useState<Project | null>(null);
  const [duplicateValue, setDuplicateValue] = useState("");
  const [duplicating, setDuplicating] = useState(false);
  const [deleteProject, setDeleteProject] = useState<Project | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [transferProject, setTransferProject] = useState<Project | null>(null);
  const [transferUsers, setTransferUsers] = useState<Array<{ id: string; username: string; displayName?: string }>>([]);
  const [transferUserId, setTransferUserId] = useState("");
  const [transferBusy, setTransferBusy] = useState(false);
  const [transferError, setTransferError] = useState("");
  const [view, setView] = useState<"grid" | "list">(() => localStorage.getItem("texlite-project-view") === "list" ? "list" : "grid");
  const [sort, setSort] = useState<"updated" | "created">(() => localStorage.getItem("texlite-project-sort") === "created" ? "created" : "updated");
  const [showArchived, setShowArchived] = useState(false);
  const [archiveBusy, setArchiveBusy] = useState("");
  const [projectMenuId, setProjectMenuId] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [relativeTimeNow, setRelativeTimeNow] = useState(() => Date.now());
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
  useEffect(() => {
    const timer = window.setInterval(() => setRelativeTimeNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
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
  const changeView = (next: "grid" | "list") => { setProjectMenuId(null); setView(next); localStorage.setItem("texlite-project-view", next); };
  const changeSort = (next: "updated" | "created") => { setSort(next); setPage(1); localStorage.setItem("texlite-project-sort", next); };
  const changeScope = (archived: boolean) => { setShowArchived(archived); setPage(1); };
  const changeTagFilter = (next: string) => { setTagFilter(next); setPage(1); };
  const createProject = async () => {
    if (!newProjectName.trim() || creating) return;
    setCreating(true);
    setCreateError("");
    try {
      const { project } = await api<{ project: Project }>("/api/projects", { method: "POST", body: JSON.stringify({ name: newProjectName }) });
      setCreateOpen(false); setNewProjectName("");
      const nextProjects = showArchived || page !== 1 ? projects : [project, ...projects].slice(0, pagination.pageSize);
      const nextPagination = showArchived ? pagination : { ...pagination, total: pagination.total + 1, totalPages: Math.ceil((pagination.total + 1) / pagination.pageSize) };
      setProjects(nextProjects); setPagination(nextPagination); if (!showArchived) onDataChange(nextProjects, tags, nextPagination);
      onOpenProject(project.id);
    } catch (e) { setCreateError(errorMessage(e)); }
    finally { setCreating(false); }
  };
  const importProject = async () => {
    if (!importFile) return;
    const maxSize = site.maxUploadSizeMB;
    if (importFile.size > maxSize * 1024 * 1024) return setImportError(t("errors.fileTooLarge", { size: maxSize }));
    setImporting(true); setImportError("");
    const data = new FormData(); data.append("file", importFile);
    try {
      const { project } = await api<{ project: Project }>(`/api/projects/import?name=${encodeURIComponent(importName.trim())}`, { method: "POST", body: data });
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
  };

  const deleteManagedTag = (tagId: string) => {
    setTags((current) => current.filter((tag) => tag.id !== tagId));
    setProjects((current) => current.map((project) => ({ ...project, tags: project.tags.filter((tag) => tag.id !== tagId) })));
    setTagProject((current) => current ? { ...current, tags: current.tags.filter((tag) => tag.id !== tagId) } : null);
    setTagFilter((current) => current === tagId ? "" : current);
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
      void load(showArchived, page, query, tagFilter, sort);
    } catch (e) { setDuplicateError(errorMessage(e)); }
    finally { setDuplicating(false); }
  };

  const removeProject = async () => {
    if (!deleteProject || deleting) return;
    setDeleting(true);
    setDeleteError("");
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
  const formatTime = (value: string) => new Date(value).toLocaleString(i18n.resolvedLanguage);
  const formatProjectCreatedDate = (value: string) => {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return value;
    return new Intl.DateTimeFormat(i18n.resolvedLanguage ?? "en", { year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
  };
  const formatProjectUpdatedTime = (value: string) => formatRelativeTime(
    value,
    i18n.resolvedLanguage ?? "en",
    relativeTimeNow,
    (key, options) => t(key, options)
  );

  return <div className="page">
    <header className="topbar">
      <a className="brand-link" href="/" aria-label={site.siteName}><span className="site-title">{site.siteName}</span><SiteLogo siteName={site.siteName} /></a>
      <div className="top-actions">
        {user.role === "admin" && <><button className="ghost" onClick={() => setMetricsOpen(true)}><Activity aria-hidden size={14} />{t("metrics.title")}</button><button className={`ghost${adminOpen ? " top-return-action" : ""}`} onClick={() => { setAdminOpen((current) => !current); setCitationLibraryOpen(false); }}>{adminOpen ? <ArrowLeft aria-hidden size={14} /> : <Users aria-hidden size={14} />}{adminOpen ? t("users.back") : t("users.manage")}</button></>}
        <button className={`ghost${citationLibraryOpen ? " top-return-action" : ""}`} onClick={() => { setAdminOpen(false); setCitationLibraryOpen((current) => !current); }}>{citationLibraryOpen ? <ArrowLeft aria-hidden size={14} /> : <BookMarked aria-hidden size={14} />}{citationLibraryOpen ? t("users.back") : t("citationLibrary.title")}</button>
        <LanguageSwitcher compact /><span className="top-user-identity"><strong>{user.displayName}</strong><small>@{user.username}</small></span><button className="ghost" onClick={logout}>{t("auth.logout")}</button>
      </div>
    </header>
    {adminOpen ? <AdminUsers currentUser={user} minPasswordLength={site.minPasswordLength} /> : citationLibraryOpen ? <main className="dashboard citation-library-page-shell">
      <CitationLibraryDialog page open onOpenChange={setCitationLibraryOpen} onBack={() => setCitationLibraryOpen(false)} currentUserId={user.id} maxBibtexBytes={site.maxCitationBibtexBytes} />
    </main> : <main className="dashboard">
      <div className="section-title"><div><h1><FolderOpen aria-hidden size={25} />{t("projects.title")}</h1><p className="muted">{user.canCreateProjects ? t("projects.subtitle") : t("projects.restricted")}</p></div><div className="section-actions"><button onClick={() => setTagManagerOpen(true)}><Tags aria-hidden size={15} />{t("tags.manage")}</button>{user.canCreateProjects && <><button onClick={() => { setImportError(""); setImportOpen(true); }}><Upload aria-hidden size={15} />{t("projects.upload")}</button><button className="primary" onClick={() => { setCreateError(""); setCreateOpen(true); }}><FolderPlus aria-hidden size={15} />{t("projects.new")}</button></>}</div></div>
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
          <div className="project-toolbar"><input type="search" placeholder={t("projects.search")} value={query} onChange={(event) => { setQuery(event.target.value); setPage(1); }} /><div className="project-scope" role="tablist" aria-label={t("projects.scope")}><button className={!showArchived ? "active" : ""} onClick={() => changeScope(false)} role="tab" aria-selected={!showArchived}><FolderOpen size={14} />{t("projects.active")}</button><button className={showArchived ? "active" : ""} onClick={() => changeScope(true)} role="tab" aria-selected={showArchived}><Archive size={14} />{t("projects.archived")}</button></div><label className="project-sort"><ArrowDownUp size={14} /><span>{t("projects.sortBy")}</span><select value={sort} onChange={(event) => changeSort(event.target.value as "updated" | "created")}><option value="updated">{t("projects.sortModified")}</option><option value="created">{t("projects.sortCreated")}</option></select></label><div className="view-toggle"><button className={view === "grid" ? "active" : ""} onClick={() => changeView("grid")} title={t("projects.grid")}>▦</button><button className={view === "list" ? "active" : ""} onClick={() => changeView("list")} title={t("projects.list")}>☷</button></div></div>
      <div className={`project-grid ${view === "list" ? "list-view" : ""}${projectMenuId ? " project-list-menu-active" : ""}`}>
        {view === "list" && filtered.length > 0 && <div className="project-list-header" aria-hidden="true"><span>{t("projects.title")}</span><span>{t("projects.owner")}</span><span>{t("projects.created")}</span><span>{t("projects.modified")}</span><span>{t("projects.actions")}</span></div>}
        {view === "list"
          ? filtered.map((project) => <ProjectListRow
            key={project.id}
            project={project}
            currentUser={user}
            showArchived={showArchived}
            archiveBusy={archiveBusy === project.id}
            menuOpen={projectMenuId === project.id}
            t={t}
            formatCreatedDate={formatProjectCreatedDate}
            formatUpdatedTime={formatProjectUpdatedTime}
            formatExactTime={formatTime}
            onOpenProject={() => { setProjectMenuId(null); onOpenProject(project.id); }}
            onToggleMenu={() => setProjectMenuId((current) => current === project.id ? null : project.id)}
            onCloseMenu={() => setProjectMenuId((current) => current === project.id ? null : current)}
            onAssignTags={() => { setTagAssignmentError(""); setTagProject(project); }}
            onRename={() => { setRenameError(""); setRenameProject(project); setRenameValue(project.name); }}
            onDuplicate={() => { setDuplicateError(""); setDuplicateProject(project); setDuplicateValue(`${project.name} (1)`); }}
            onArchive={() => void toggleArchive(project)}
            onTransfer={() => void openTransfer(project)}
            onDelete={() => { setDeleteProject(project); setDeleteError(""); }}
          />)
          : filtered.map((project) => <article className={`project-card${project.ownerId === user.id ? " owned-project" : ""}`} key={project.id}>
            {project.ownerId === user.id && <button className="project-transfer-action" title={t("projects.transferOwnership")} onClick={() => void openTransfer(project)}><ArrowRightLeft aria-hidden size={13} />{t("projects.transfer")}</button>}
            <button className="project-card-open" onClick={() => onOpenProject(project.id)}>
              <span className="owner-badge" title={project.ownerDisplayName ?? project.ownerUsername}>{project.ownerDisplayName ?? project.ownerUsername}</span>
              <span className="project-card-main">
                <strong title={project.name}>{project.name}</strong>
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
                <div><dt><History aria-hidden size={13} />{t("projects.modified")}</dt><dd title={t("projects.modifiedByUser", { time: formatTime(project.updatedAt), user: project.lastModifiedDisplayName ?? project.lastModifiedUsername ?? t("projects.deletedUser") })}><time dateTime={project.updatedAt}>{formatProjectUpdatedTime(project.updatedAt)}</time><span className="project-modified-by"> · {t("projects.byUser", { user: project.lastModifiedDisplayName ?? project.lastModifiedUsername ?? t("projects.deletedUser") })}</span></dd></div>
              </dl>
            </button>
            <div className="project-card-actions">
              <button onClick={() => { setTagAssignmentError(""); setTagProject(project); }}><Tags aria-hidden size={14} />{t("tags.assign")}</button>
              {project.permission === "owner" && <button onClick={() => { setRenameError(""); setRenameProject(project); setRenameValue(project.name); }}><Pencil aria-hidden size={14} />{t("projects.rename")}</button>}
              {(user.role === "admin" || user.canCreateProjects) && <button onClick={() => { setDuplicateError(""); setDuplicateProject(project); setDuplicateValue(`${project.name} (1)`); }}><Copy aria-hidden size={14} />{t("projects.duplicate")}</button>}
              <a href={`/api/projects/${project.id}/download`} download><Download aria-hidden size={14} />{t("projects.download")}</a>
              <button disabled={archiveBusy === project.id} onClick={() => void toggleArchive(project)}>{showArchived ? <ArchiveRestore aria-hidden size={14} /> : <Archive aria-hidden size={14} />}{showArchived ? t("projects.unarchive") : t("projects.archive")}</button>
              {project.permission === "owner" && <button className="danger-text" onClick={() => { setDeleteProject(project); setDeleteError(""); }}><Trash2 aria-hidden size={14} />{t("common.delete")}</button>}
            </div>
          </article>)}
        {filtered.length === 0 && (projects.length === 0
          ? showArchived ? <div className="empty">{t("projects.noArchived")}</div> : <div className="project-empty"><span className="project-empty-icon"><Sparkles size={28} /></span><h2>{t("projects.emptyTitle")}</h2><p>{user.canCreateProjects ? t("projects.emptyDescription") : t("projects.emptyRestricted")}</p></div>
          : <div className="empty">{t("projects.noMatches")}</div>)}
      </div>
      {pagination.totalPages > 1 && <nav className="project-pagination" aria-label={t("projects.pagination")}><button disabled={pagination.page <= 1} onClick={() => setPage((current) => Math.max(1, current - 1))} title={t("projects.previousPage")}><ChevronLeft size={15} />{t("projects.previousPage")}</button><span>{t("projects.pageOf", { page: pagination.page, totalPages: pagination.totalPages, count: pagination.total })}</span><button disabled={pagination.page >= pagination.totalPages} onClick={() => setPage((current) => Math.min(pagination.totalPages, current + 1))} title={t("projects.nextPage")}><ChevronRight size={15} />{t("projects.nextPage")}</button></nav>}
        </div>
      </div>
      <Modal open={createOpen} title={t("projects.new")} description={t("projects.newDescription")} onOpenChange={(open) => { if (!open && creating) return; setCreateOpen(open); if (!open) setCreateError(""); }} footer={<><button disabled={creating} onClick={() => setCreateOpen(false)}>{t("common.cancel")}</button><button className="primary" disabled={creating || !newProjectName.trim()} aria-busy={creating} onClick={() => void createProject()}>{creating && <LoaderCircle className="spin" size={14} />}{creating ? t("common.loading") : t("common.create")}</button></>}>
        <>{createError && <p className="error dialog-error">{createError}</p>}<label className="form-field">{t("projects.name")}<input autoFocus value={newProjectName} onChange={(event) => { setNewProjectName(event.target.value); setCreateError(""); }} onKeyDown={(event) => { if (event.key === "Enter") void createProject(); }} /></label></>
      </Modal>
      <Modal open={importOpen} title={t("projects.upload")} description={t("projects.uploadDescription", { size: site.maxUploadSizeMB })} onOpenChange={(open) => { setImportOpen(open); if (!open) setImportError(""); }} footer={<><button onClick={() => { setImportOpen(false); setImportError(""); }}>{t("common.cancel")}</button><button className="primary" disabled={!importFile || importing} onClick={() => void importProject()}>{importing ? t("projects.importing") : t("projects.import")}</button></>}><div className="form-stack">{importError && <p className="error import-error">{importError}</p>}<div className={`upload-picker${importFile ? " has-file" : ""}`} onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; }} onDrop={(event) => { event.preventDefault(); selectImportFile(event.dataTransfer.files[0] ?? null); }}><input ref={importInput} className="sr-only" type="file" accept=".zip,application/zip" onChange={(event) => selectImportFile(event.target.files?.[0] ?? null)} /><FileArchive size={34} /><div className="upload-picker-copy"><strong>{importFile?.name ?? t("projects.chooseZip")}</strong><span>{importFile ? t("projects.selectedFileSize", { size: formatFileSize(importFile.size) }) : t("projects.dropZip")}</span></div><button type="button" onClick={() => importInput.current?.click()}><Upload size={15} />{t("projects.browse")}</button>{importFile && <button className="upload-clear" type="button" title={t("projects.clearFile")} aria-label={t("projects.clearFile")} onClick={() => { selectImportFile(null); if (importInput.current) importInput.current.value = ""; }}><X size={14} /></button>}</div><label className="form-field">{t("projects.name")}<input value={importName} onChange={(event) => setImportName(event.target.value)} /></label></div></Modal>
      <TagManagementDialog open={tagManagerOpen} onOpenChange={setTagManagerOpen} onTagCreated={addManagedTag} onTagUpdated={updateManagedTag} onTagDeleted={deleteManagedTag} />
      <Modal open={Boolean(tagProject)} title={t("tags.assignTitle", { project: tagProject?.name ?? "" })} description={t("tags.assignDescription")} onOpenChange={(open) => { if (!open) { setTagProject(null); setTagAssignmentError(""); } }} footer={<button onClick={() => { setTagProject(null); setTagAssignmentError(""); }}>{t("common.close")}</button>}><div className="tag-assignment-list">{tagAssignmentError && <p className="error dialog-error">{tagAssignmentError}</p>}{tags.map((tag) => <label key={tag.id}><input type="checkbox" checked={Boolean(tagProject?.tags.some((item) => item.id === tag.id))} onChange={() => void toggleProjectTag(tag)} /><TagDot color={tag.color} /><span>{tag.name}</span></label>)}{tags.length === 0 && <p className="muted">{t("tags.empty")}</p>}</div></Modal>
      <Modal open={Boolean(renameProject)} title={t("projects.renameTitle")} onOpenChange={(open) => { if (!open && renaming) return; if (!open) { setRenameProject(null); setRenameError(""); } }} footer={<><button disabled={renaming} onClick={() => { setRenameProject(null); setRenameError(""); }}>{t("common.cancel")}</button><button className="primary" disabled={renaming || !renameValue.trim()} aria-busy={renaming} onClick={() => void rename()}>{renaming && <LoaderCircle className="spin" size={14} />}{renaming ? t("common.loading") : t("projects.rename")}</button></>}><>{renameError && <p className="error dialog-error">{renameError}</p>}<label className="form-field">{t("projects.name")}<input autoFocus value={renameValue} onChange={(event) => { setRenameValue(event.target.value); setRenameError(""); }} onKeyDown={(event) => { if (event.key === "Enter") void rename(); }} /></label></></Modal>
      <Modal open={Boolean(duplicateProject)} title={t("projects.duplicateTitle")} description={t("projects.duplicateDescription", { project: duplicateProject?.name ?? "" })} onOpenChange={(open) => { if (!open && !duplicating) { setDuplicateProject(null); setDuplicateValue(""); setDuplicateError(""); } }} footer={<><button disabled={duplicating} onClick={() => { setDuplicateProject(null); setDuplicateValue(""); setDuplicateError(""); }}>{t("common.cancel")}</button><button className="primary" disabled={duplicating || !duplicateValue.trim()} onClick={() => void duplicate()}>{duplicating ? t("projects.duplicating") : t("projects.duplicate")}</button></>}><>{duplicateError && <p className="error dialog-error">{duplicateError}</p>}<label className="form-field">{t("projects.name")}<input autoFocus value={duplicateValue} onChange={(event) => { setDuplicateValue(event.target.value); setDuplicateError(""); }} onKeyDown={(event) => { if (event.key === "Enter") void duplicate(); }} /></label></></Modal>
      <Modal open={Boolean(transferProject)} title={t("projects.transferOwnership")} description={t("projects.transferDescription", { project: transferProject?.name ?? "" })} onOpenChange={(open) => { if (!open && !transferBusy) { setTransferProject(null); setTransferUserId(""); setTransferError(""); } }} footer={<><button disabled={transferBusy} onClick={() => { setTransferProject(null); setTransferUserId(""); setTransferError(""); }}>{t("common.cancel")}</button><button className="primary" disabled={transferBusy || !transferUserId} onClick={() => void transferOwnership()}>{transferBusy ? <LoaderCircle className="spin" size={14} /> : <ArrowRightLeft size={14} />}{t("projects.transfer")}</button></>}><div className="form-stack">{transferError && <p className="error dialog-error">{transferError}</p>}<label className="form-field">{t("projects.newOwner")}<select disabled={transferBusy || transferUsers.length === 0} value={transferUserId} onChange={(event) => setTransferUserId(event.target.value)}><option value="">{transferBusy ? t("common.loading") : transferUsers.length > 0 ? t("projects.chooseNewOwner") : t("projects.noTransferUsers")}</option>{transferUsers.map((candidate) => <option value={candidate.id} key={candidate.id}>{candidate.displayName ?? candidate.username} (@{candidate.username})</option>)}</select></label><p className="warning"><AlertTriangle size={15} />{t("projects.transferWarning")}</p></div></Modal>
      <ConfirmDialog open={Boolean(deleteProject)} title={t("projects.deleteTitle")} description={t("projects.deleteDescription", { project: deleteProject?.name ?? "" })} confirmLabel={deleting ? t("common.loading") : t("common.delete")} danger busy={deleting} error={deleteError} onCancel={() => { if (!deleting) { setDeleteProject(null); setDeleteError(""); } }} onConfirm={() => void removeProject()} />
    </main>}{metricsOpen && <Suspense fallback={null}><SystemMetricsDialog open onOpenChange={setMetricsOpen} /></Suspense>}<SiteFooter />
  </div>;
}

function TagDot({ color }: { color: TagColor }) {
  return <span className={`tag-dot tag-${color}`} />;
}
