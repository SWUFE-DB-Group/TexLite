import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import type { TFunction } from "i18next";
import { Archive, ArchiveRestore, ArrowRightLeft, Copy, Download, MessageSquare, MoreHorizontal, Pencil, Tags, Trash2 } from "lucide-react";
import type { Project, User } from "../types";

type ProjectMenuItem = {
  id: string;
  label: string;
  icon: ReactNode;
  section: "main" | "danger";
  disabled?: boolean;
  href?: string;
  onSelect?: () => void;
};

export function projectInitial(projectName: string): string {
  const initial = Array.from(projectName.trim())[0];
  return initial ? initial.toLocaleUpperCase() : "?";
}

export function ProjectListRow({
  project,
  currentUser,
  showArchived,
  archiveBusy,
  menuOpen,
  t,
  formatCreatedDate,
  formatUpdatedTime,
  formatExactTime,
  onOpenProject,
  onToggleMenu,
  onCloseMenu,
  onAssignTags,
  onRename,
  onDuplicate,
  onArchive,
  onTransfer,
  onDelete
}: {
  project: Project;
  currentUser: User;
  showArchived: boolean;
  archiveBusy: boolean;
  menuOpen: boolean;
  t: TFunction;
  formatCreatedDate: (value: string) => string;
  formatUpdatedTime: (value: string) => string;
  formatExactTime: (value: string) => string;
  onOpenProject: () => void;
  onToggleMenu: () => void;
  onCloseMenu: () => void;
  onAssignTags: () => void;
  onRename: () => void;
  onDuplicate: () => void;
  onArchive: () => void;
  onTransfer: () => void;
  onDelete: () => void;
}) {
  const root = useRef<HTMLElement>(null);
  const ownerName = project.ownerDisplayName ?? project.ownerUsername ?? t("projects.deletedUser");
  const modifiedBy = project.lastModifiedDisplayName ?? project.lastModifiedUsername ?? t("projects.deletedUser");
  const canRename = project.permission === "owner";
  const canDuplicate = currentUser.role === "admin" || currentUser.canCreateProjects;
  const canTransfer = project.ownerId === currentUser.id;
  const canDelete = project.permission === "owner";

  useEffect(() => {
    if (!menuOpen) return;
    const closeWhenOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) onCloseMenu();
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCloseMenu();
    };
    document.addEventListener("pointerdown", closeWhenOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeWhenOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [menuOpen, onCloseMenu]);

  const menuItems: ProjectMenuItem[] = [
    { id: "tags", label: t("tags.assign"), icon: <Tags aria-hidden size={15} />, section: "main", onSelect: onAssignTags },
    ...(canRename ? [{ id: "rename", label: t("projects.rename"), icon: <Pencil aria-hidden size={15} />, section: "main" as const, onSelect: onRename }] : []),
    ...(canDuplicate ? [{ id: "duplicate", label: t("projects.duplicate"), icon: <Copy aria-hidden size={15} />, section: "main" as const, onSelect: onDuplicate }] : []),
    { id: "download", label: t("projects.download"), icon: <Download aria-hidden size={15} />, section: "main", href: `/api/projects/${project.id}/download` },
    { id: "archive", label: showArchived ? t("projects.unarchive") : t("projects.archive"), icon: showArchived ? <ArchiveRestore aria-hidden size={15} /> : <Archive aria-hidden size={15} />, section: "main", disabled: archiveBusy, onSelect: onArchive },
    ...(canTransfer ? [{ id: "transfer", label: t("projects.transfer"), icon: <ArrowRightLeft aria-hidden size={15} />, section: "main" as const, onSelect: onTransfer }] : []),
    ...(canDelete ? [{ id: "delete", label: t("common.delete"), icon: <Trash2 aria-hidden size={15} />, section: "danger" as const, onSelect: onDelete }] : [])
  ];
  const primaryItems = menuItems.filter((item) => item.section === "main");
  const dangerItems = menuItems.filter((item) => item.section === "danger");
  const selectItem = (item: ProjectMenuItem) => {
    if (item.disabled) return;
    onCloseMenu();
    item.onSelect?.();
  };

  return <article ref={root} className={`project-card project-list-row${project.ownerId === currentUser.id ? " owned-project" : ""}${menuOpen ? " project-list-menu-open" : ""}`}>
    <button type="button" className="project-list-open" onClick={onOpenProject} aria-label={t("projects.openProject", { project: project.name })}>
      <span className="project-list-avatar" aria-hidden="true">{projectInitial(project.name)}</span>
      <span className="project-list-summary">
        <span className="project-list-title-line">
          <strong className="project-list-title" title={project.name}>{project.name}</strong>
          {Boolean(project.unresolvedCommentCount && project.unresolvedCommentCount > 0) && (
            <span className="project-comments-badge unresolved" title={t("projects.unresolvedCommentsTooltip", { unresolved: project.unresolvedCommentCount, total: project.commentCount ?? project.unresolvedCommentCount })}>
              <MessageSquare aria-hidden size={10} />
              <span>{t("projects.unresolvedCount", { count: project.unresolvedCommentCount })}</span>
            </span>
          )}
          {project.tags?.length > 0 && <span className="project-list-tags">{project.tags.map((tag) => <span className={`tag tag-${tag.color} project-list-tag`} key={tag.id} title={tag.name}>{tag.name}</span>)}</span>}
        </span>
      </span>
      <span className="project-list-owner" title={ownerName}>
        <span className="sr-only">{t("projects.owner")}: </span>
        {ownerName}
      </span>
      <span className="project-list-created" title={formatExactTime(project.createdAt)}>
        <span className="sr-only">{t("projects.created")}: </span>
        <time dateTime={project.createdAt}>{formatCreatedDate(project.createdAt)}</time>
      </span>
      <span className="project-list-modified" title={t("projects.modifiedByUser", { time: formatExactTime(project.updatedAt), user: modifiedBy })}>
        <span className="sr-only">{t("projects.modified")}: </span>
        <time dateTime={project.updatedAt}>{formatUpdatedTime(project.updatedAt)}</time>
        <small>{t("projects.byUser", { user: modifiedBy })}</small>
      </span>
    </button>
    <div className="project-list-menu-root">
      <button
        type="button"
        className="project-list-menu-trigger"
        aria-label={t("projects.projectActions", { project: project.name })}
        aria-expanded={menuOpen}
        aria-controls={`project-actions-${project.id}`}
        onClick={(event) => { event.stopPropagation(); onToggleMenu(); }}
      ><MoreHorizontal aria-hidden size={19} /></button>
      {menuOpen && <div id={`project-actions-${project.id}`} className="project-list-menu" role="group" aria-label={t("projects.projectActions", { project: project.name })} onClick={(event) => event.stopPropagation()}>
        {primaryItems.map((item) => item.href
          ? <a key={item.id} href={item.href} download onClick={(event) => { event.stopPropagation(); onCloseMenu(); }}>{item.icon}{item.label}</a>
          : <button key={item.id} type="button" disabled={item.disabled} onClick={(event) => { event.stopPropagation(); selectItem(item); }}>{item.icon}{item.label}</button>)}
        {dangerItems.length > 0 && <><div className="project-list-menu-separator" aria-hidden="true" />{dangerItems.map((item) => <button key={item.id} type="button" className="danger" onClick={(event) => { event.stopPropagation(); selectItem(item); }}>{item.icon}{item.label}</button>)}</>}
      </div>}
    </div>
  </article>;
}
