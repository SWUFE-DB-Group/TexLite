import type { TFunction } from "i18next";
import { AtSign, MessageSquare } from "lucide-react";
import { ProjectIconAvatar } from "../projectIcons";
import type { Project, User } from "../types";
import { ProjectActionMenu } from "./ProjectActionMenu";

export { projectInitial } from "../projectIcons";

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
  onOpenMention,
  onToggleMenu,
  onCloseMenu,
  onAssignTags,
  onRename,
  onDuplicate,
  onArchive,
  onTransfer,
  onDelete,
  onChooseIcon
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
  onOpenMention: () => void;
  onToggleMenu: () => void;
  onCloseMenu: () => void;
  onAssignTags: () => void;
  onRename: () => void;
  onDuplicate: () => void;
  onArchive: () => void;
  onTransfer: () => void;
  onDelete: () => void;
  onChooseIcon: () => void;
}) {
  const ownerName = project.ownerDisplayName ?? project.ownerUsername ?? t("projects.deletedUser");
  const modifiedBy = project.lastModifiedDisplayName ?? project.lastModifiedUsername ?? t("projects.deletedUser");

  return <article
    className={`project-card project-list-row${project.ownerId === currentUser.id ? " owned-project" : ""}${menuOpen ? " project-list-menu-open" : ""}`}
    onClick={(event) => { if (event.target === event.currentTarget) onOpenProject(); }}
  >
    <ProjectIconAvatar
      icon={project.icon}
      projectName={project.name}
      title={project.name}
      editable={project.permission === "owner"}
      editLabel={t("projectIcons.change")}
      onEdit={onChooseIcon}
      className="project-list-avatar"
    />
    <span className="project-list-summary">
      <button type="button" className="project-list-cell-open project-list-summary-open" onClick={onOpenProject} aria-label={t("projects.openProject", { project: project.name })}>
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
      </button>
    </span>
    <button type="button" className="project-list-cell-open project-list-owner" onClick={onOpenProject} title={ownerName} aria-label={t("projects.openProject", { project: project.name })}>
      <span className="sr-only">{t("projects.owner")}: </span>
      {ownerName}
    </button>
    <button type="button" className="project-list-cell-open project-list-created" onClick={onOpenProject} title={formatExactTime(project.createdAt)} aria-label={t("projects.openProject", { project: project.name })}>
      <span className="sr-only">{t("projects.created")}: </span>
      <time dateTime={project.createdAt}>{formatCreatedDate(project.createdAt)}</time>
    </button>
    <button type="button" className="project-list-cell-open project-list-modified" onClick={onOpenProject} title={t("projects.modifiedByUser", { time: formatExactTime(project.updatedAt), user: modifiedBy })} aria-label={t("projects.openProject", { project: project.name })}>
      <span className="sr-only">{t("projects.modified")}: </span>
      <time dateTime={project.updatedAt}>{formatUpdatedTime(project.updatedAt)}</time>
      <small>{t("projects.byUser", { user: modifiedBy })}</small>
    </button>
    {Boolean(project.unreadMentionCount && project.unreadMentionCount > 0)
      ? <button className="project-mentions-badge project-list-mentions" type="button" title={t("projects.unreadMentionsTooltip", { count: project.unreadMentionCount })} onClick={onOpenMention}>
          <AtSign aria-hidden size={10} />
          <span>{project.unreadMentionCount}</span>
        </button>
      : <span className="project-list-mentions" />}
    <ProjectActionMenu
      variant="list"
      project={project}
      currentUser={currentUser}
      showArchived={showArchived}
      archiveBusy={archiveBusy}
      menuOpen={menuOpen}
      t={t}
      onToggleMenu={onToggleMenu}
      onCloseMenu={onCloseMenu}
      onAssignTags={onAssignTags}
      onRename={onRename}
      onDuplicate={onDuplicate}
      onArchive={onArchive}
      onTransfer={onTransfer}
      onDelete={onDelete}
    />
  </article>;
}
