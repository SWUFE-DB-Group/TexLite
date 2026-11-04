import { AtSign, MessageSquare } from "lucide-react";
import { captureDeletionHeight } from "../useDeletionTransitions";
import { ProjectActionMenu, type ProjectActionMenuProps } from "./ProjectActionMenu";
import type { ProjectSourcePreview } from "../../shared/projectCatalog";

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
  const details = [project.name, `${t("projects.created")}: ${formatExactTime(project.createdAt)}`,
    `${t("projects.owner")}: ${owner}`, `${t("projects.modified")}: ${formatExactTime(project.updatedAt)}`].join("\n");

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
        <strong className="project-card-title" data-tooltip={details}>{project.name}</strong>
        <div className="project-card-metadata">
          <time dateTime={project.updatedAt}>{formatUpdatedTime(project.updatedAt)}</time>
          <span aria-hidden="true">·</span><span className="project-card-modifier">{modifier}</span>
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
