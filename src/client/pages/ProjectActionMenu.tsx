import { useEffect, useRef, type ReactNode } from "react";
import type { TFunction } from "i18next";
import { Archive, ArchiveRestore, ArrowRightLeft, Copy, Download, MoreHorizontal, Pencil, Tags, Trash2 } from "lucide-react";
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

export interface ProjectActionMenuProps {
  project: Project;
  currentUser: User;
  showArchived: boolean;
  archiveBusy: boolean;
  menuOpen: boolean;
  t: TFunction;
  variant: "grid" | "list";
  onToggleMenu: () => void;
  onCloseMenu: () => void;
  onAssignTags: () => void;
  onRename: () => void;
  onDuplicate: () => void;
  onArchive: () => void;
  onTransfer: () => void;
  onDelete: () => void;
}

/** Shared, data-driven project action menu for list and grid cards. */
export function ProjectActionMenu({
  project,
  currentUser,
  showArchived,
  archiveBusy,
  menuOpen,
  t,
  variant,
  onToggleMenu,
  onCloseMenu,
  onAssignTags,
  onRename,
  onDuplicate,
  onArchive,
  onTransfer,
  onDelete
}: ProjectActionMenuProps) {
  const root = useRef<HTMLDivElement>(null);
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

  return <div ref={root} className={`project-action-menu-root project-action-menu-${variant}`} onClick={(event) => event.stopPropagation()}>
    <button
      type="button"
      className="project-action-menu-trigger"
      aria-label={t("projects.projectActions", { project: project.name })}
      aria-expanded={menuOpen}
      aria-controls={`project-actions-${project.id}`}
      onClick={(event) => { event.stopPropagation(); onToggleMenu(); }}
    ><MoreHorizontal aria-hidden size={19} /></button>
    {menuOpen && <div id={`project-actions-${project.id}`} className="project-action-menu" role="group" aria-label={t("projects.projectActions", { project: project.name })}>
      {primaryItems.map((item) => item.href
        ? <a key={item.id} href={item.href} download onClick={(event) => { event.stopPropagation(); onCloseMenu(); }}>{item.icon}{item.label}</a>
        : <button key={item.id} type="button" disabled={item.disabled} onClick={(event) => { event.stopPropagation(); selectItem(item); }}>{item.icon}{item.label}</button>)}
      {dangerItems.length > 0 && <><div className="project-action-menu-separator" aria-hidden="true" />{dangerItems.map((item) => <button key={item.id} type="button" className="danger" onClick={(event) => { event.stopPropagation(); selectItem(item); }}>{item.icon}{item.label}</button>)}</>}
    </div>}
  </div>;
}
