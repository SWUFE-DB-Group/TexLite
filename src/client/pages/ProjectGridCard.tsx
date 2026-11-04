import { AtSign, CalendarDays, Clock, History, MessageSquare } from "lucide-react";
import { Trans } from "react-i18next";
import { captureDeletionHeight } from "../useDeletionTransitions";
import { ProjectActionMenu, type ProjectActionMenuProps } from "./ProjectActionMenu";
import type { ProjectSourcePreview } from "../../shared/projectCatalog";
import { RichTooltip } from "../GlobalTooltip";

interface ProjectGridCardProps extends Omit<ProjectActionMenuProps, "variant"> {
  removing: boolean;
  onRemovalEnd: () => void;
  onOpenProject: () => void;
  onOpenMention: () => void;
  formatUpdatedTime: (value: string) => string;
  formatExactTime: (value: string) => string;
}

/** Source-derived illustration, not a compiled PDF or a separate image request. */
function ProjectPaper({ preview }: { preview: ProjectSourcePreview | null | undefined }) {
  const unknown = preview == null;
  const hasContent = unknown || Boolean(preview.title || preview.abstract);
  return <div className="project-paper" aria-hidden="true">
    {hasContent && <>
      {preview?.title ? <div className="project-paper-title">{preview.title}</div>
        : <div className="project-paper-heading"><span /><span /></div>}
      <span className="project-paper-byline" />
      <div className="project-paper-abstract-label">Abstract</div>
      {preview?.abstract && <p className="project-paper-summary">{preview.abstract}</p>}
      <div className="project-paper-lines"><span /><span /><span /><span /><span /></div>
    </>}
  </div>;
}

export function ProjectGridCard({ removing, onRemovalEnd, onOpenProject, onOpenMention,
  formatUpdatedTime, formatExactTime, ...menu }: ProjectGridCardProps) {
  const { project, t } = menu;
  const owner = project.ownerDisplayName ?? project.ownerUsername ?? t("projects.deletedUser");
  const modifier = project.lastModifiedDisplayName ?? project.lastModifiedUsername ?? t("projects.deletedUser");
  const nameDetails = <div className="project-details-tooltip project-name-tooltip">
    <strong>{project.name}</strong>{", "}
    <span className="project-details-person"><Trans t={t} i18nKey="projects.ownedBy" values={{ user: owner }} components={{ user: <strong className="project-details-name" /> }} /></span>
  </div>;
  const timeDetails = <div className="project-details-tooltip">
    <ul>
      <li><CalendarDays aria-hidden size={14} /><div>
        <time dateTime={project.createdAt}>{t("projects.createdAt", { time: formatExactTime(project.createdAt) })}</time>
      </div></li>
      <li><History aria-hidden size={14} /><div>
        <time dateTime={project.updatedAt}><Trans t={t} i18nKey="projects.lastModifiedAt"
          values={{ time: formatExactTime(project.updatedAt), user: modifier }} components={{ user: <strong className="project-details-name" /> }} /></time>
      </div></li>
    </ul>
  </div>;

  return <article ref={removing ? captureDeletionHeight : undefined}
    inert={removing ? true : undefined} aria-hidden={removing ? true : undefined}
    className={`project-card project-grid-card${menu.menuOpen ? " project-card-menu-open" : ""}${removing ? " deletion-exit" : ""}`}
    onAnimationEnd={(event) => { if (event.target === event.currentTarget && removing) onRemovalEnd(); }}>
    <button type="button" className="project-card-open" aria-label={t("projects.openProject", { project: project.name })} onClick={onOpenProject}>
      <div className="project-card-thumbnail">
        <ProjectPaper preview={project.preview} />
        <div className="project-card-tags" title={project.tags.map((tag) => tag.name).join(", ")}>
          {project.tags.map((tag) => <span className={`tag tag-${tag.color}`} key={tag.id}>{tag.name}</span>)}
        </div>
      </div>
      <div className="project-card-caption">
        <RichTooltip text={project.name} content={nameDetails}><strong className="project-card-title">{project.name}</strong></RichTooltip>
        <div className="project-card-metadata">
          <RichTooltip text={formatExactTime(project.updatedAt)} content={timeDetails}>
            <time dateTime={project.updatedAt}><Clock aria-hidden size={12} strokeWidth={1.75} /><span>{formatUpdatedTime(project.updatedAt)}</span></time>
          </RichTooltip>
          <span aria-hidden="true">·</span><span className="project-card-modifier">{t("projects.byUserInline", { user: modifier })}</span>
        </div>
      </div>
    </button>
    <div className="project-card-badges">
      {Boolean(project.unreadMentionCount && project.unreadMentionCount > 0) && <button className="project-mentions-badge" type="button"
        title={t("projects.unreadMentionsTooltip", { count: project.unreadMentionCount })}
        aria-label={t("projects.unreadMentionsTooltip", { count: project.unreadMentionCount })} onClick={onOpenMention}>
        <AtSign aria-hidden size={12} /><span>{project.unreadMentionCount}</span>
      </button>}
      {Boolean(project.unresolvedCommentCount && project.unresolvedCommentCount > 0) && <button className="project-comments-badge unresolved" type="button"
        data-tooltip={t("projects.unresolvedCount", { count: project.unresolvedCommentCount })}
        aria-label={t("projects.unresolvedCount", { count: project.unresolvedCommentCount })} onClick={onOpenProject}>
        <MessageSquare aria-hidden size={12} /><span>{project.unresolvedCommentCount}</span>
      </button>}
    </div>
    <ProjectActionMenu {...menu} variant="grid" />
  </article>;
}
