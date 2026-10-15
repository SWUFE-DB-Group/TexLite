import { useCallback, useEffect, useId, useState, useSyncExternalStore, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { Trans, useTranslation } from "react-i18next";
import { AtSign, CheckCircle2, ChevronDown, ChevronUp, Reply, RotateCcw, Trash2, UserPlus, Users } from "lucide-react";
import { api } from "../api";
import { ConfirmDialog, Modal } from "../Dialog";
import { errorMessage } from "../errors";
import i18n from "../i18n";
import type { Comment, Project } from "../types";
import { CommentActionsMenu } from "./CommentActionsMenu";
import { CommentForm } from "./CommentForm";
import { CommentDraftStore, type CommentDraftKey } from "./commentDrafts";
import { commentReplyVisibility } from "./commentReplyVisibility";

/**
 * Comment display intentionally treats a whitespace-delimited `@username`
 * token as a visual mention without checking whether that user exists.  This
 * keeps the display rule obvious and preserves ordinary e-mail addresses.
 */
function renderCommentContent(content: string): ReactNode {
  const pattern = /(^|\s)(@[\p{L}\p{N}_.-]+)/gu;
  const nodes: ReactNode[] = [];
  let cursor = 0;

  for (const match of content.matchAll(pattern)) {
    const start = match.index ?? 0;
    const boundary = match[1];
    const mention = match[2];
    const mentionStart = start + boundary.length;
    if (mentionStart > cursor) nodes.push(content.slice(cursor, mentionStart));
    nodes.push(<span className="comment-inline-mention" key={`${mentionStart}:${mention}`}>{mention}</span>);
    cursor = mentionStart + mention.length;
  }

  if (!nodes.length) return content;
  if (cursor < content.length) nodes.push(content.slice(cursor));
  return nodes;
}

export function CommentThread({
  projectId, comment, draftStore, currentUserId, unreadCommentMentionId, unreadReplyMentionIds,
  highlightedComment, highlightedReplyId, currentComment, showFilePath, onMarkMentionRead, onFocus, onActivate, onToggle,
  onReply, onEdit, onDelete, onEditReply, onDeleteReply, selectedParticipantIds, highlightReplyParticipants,
  replyExpansion, onReplyExpansionChange
}: {
  projectId: string;
  comment: Comment;
  draftStore: CommentDraftStore;
  currentUserId: string;
  unreadCommentMentionId?: string;
  unreadReplyMentionIds?: ReadonlyMap<string, string>;
  highlightedComment?: boolean;
  highlightedReplyId?: string | null;
  currentComment?: boolean;
  showFilePath?: boolean;
  selectedParticipantIds?: ReadonlySet<string | null>;
  highlightReplyParticipants?: boolean;
  replyExpansion?: boolean;
  onReplyExpansionChange: (expanded: boolean) => void;
  onMarkMentionRead: (mentionId: string) => Promise<boolean>;
  onFocus: () => void;
  /** Activate discussion controls without navigating to or focusing the source editor. */
  onActivate: () => void;
  onToggle: () => Promise<void>;
  onReply: (content: string) => Promise<boolean>;
  onEdit: (content: string) => Promise<boolean>;
  onDelete: () => Promise<boolean>;
  onEditReply: (replyId: string, content: string) => Promise<boolean>;
  onDeleteReply: (replyId: string) => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const [toggling, setToggling] = useState(false);
  const subscribe = useCallback((listener: () => void) => draftStore.subscribe(comment.id, listener), [draftStore, comment.id]);
  const getDrafts = useCallback(() => draftStore.getThread(comment.id), [draftStore, comment.id]);
  const drafts = useSyncExternalStore(subscribe, getDrafts, getDrafts);
  const replyDraft = drafts.reply;
  const commentEditDraft = drafts["edit-comment"];
  const repliesId = useId();
  const visibleReplies = commentReplyVisibility(comment.replies, {
    expansion: replyExpansion, current: currentComment, targetReplyId: highlightedReplyId,
    unreadReplyMentionIds, selectedParticipantIds, highlightReplyParticipants,
    activeDraft: Boolean(replyDraft?.open || replyDraft?.pending
      || comment.authorId === currentUserId && commentEditDraft?.open
      || comment.replies.some((reply) => reply.authorId === currentUserId && drafts[`edit-reply:${reply.id}`]?.open))
  });
  const submittingForm = draftStore.isPending(comment.id);
  const [autoFocusDraft, setAutoFocusDraft] = useState<CommentDraftKey | null>(null);
  const [deleteCommentOpen, setDeleteCommentOpen] = useState(false);
  const [deleteReplyId, setDeleteReplyId] = useState<string | null>(null);
  const openDraft = (key: CommentDraftKey, content = "") => {
    onActivate();
    onReplyExpansionChange(true);
    setAutoFocusDraft(key);
    draftStore.open(comment.id, key, content);
  };
  const draftForm = (key: CommentDraftKey, label: string, submit: (content: string) => Promise<boolean>) => {
    const draft = drafts[key];
    if (!draft?.open) return null;
    return <CommentForm key={key} projectId={projectId} editing={key !== "reply"} label={label}
      value={draft.content} pending={draft.pending} error={draft.error} disabled={submittingForm || toggling}
      autoFocus={autoFocusDraft === key} onChange={(content) => draftStore.change(comment.id, key, content)}
      onSubmit={() => draftStore.submit(comment.id, key, submit, t("editor.commentSubmitFailed"))}
      onCancel={() => draftStore.discard(comment.id, key)} />;
  };
  const username = comment.authorUsername;
  const formatTime = (value: string) => new Date(value).toLocaleString(i18n.resolvedLanguage);
  const markRead = async (mentionId: string, event: ReactMouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    // Reading an old mention must not make that reply disappear immediately.
    onReplyExpansionChange(true);
    await onMarkMentionRead(mentionId);
  };
  return <><article data-comment-id={comment.id} className={`comment-thread${comment.resolved ? " resolved" : ""}${comment.orphaned ? " orphaned" : ""}${highlightedComment ? " mention-target" : ""}${currentComment ? " review-current" : ""}`} onFocusCapture={onActivate} onClick={() => { if (!window.getSelection()?.toString()) onFocus(); }}>
    <header className="comment-header">
      <span className={`comment-author${selectedParticipantIds?.has(comment.authorId) ? " participant-match" : ""}`}><strong>{comment.authorDisplayName ?? username ?? t("editor.deletedUser")}</strong>{username && <small>@{username}</small>}</span>
      <span className="comment-header-actions">
        <span className="comment-times"><time dateTime={comment.createdAt} title={new Date(comment.createdAt).toISOString()}>{formatTime(comment.createdAt)}</time>{comment.editedAt && <small>{t("editor.editedAt", { time: formatTime(comment.editedAt) })}</small>}</span>
        {comment.authorId === currentUserId && !commentEditDraft?.open && <CommentActionsMenu kind="comment"
          disabled={submittingForm || toggling}
          onEdit={() => openDraft("edit-comment", comment.content)}
          onDelete={() => setDeleteCommentOpen(true)} />}
      </span>
    </header>
    <div className="comment-location">{comment.orphaned ? t("editor.orphaned") : showFilePath ? t("editor.commentLocation", { path: comment.filePath, line: comment.startLine }) : t("editor.line", { line: comment.startLine })}</div>
    {comment.selectedText && <blockquote className="comment-selected-text">{comment.selectedText}</blockquote>}
    {commentEditDraft?.open && comment.authorId === currentUserId ? draftForm("edit-comment", t("editor.editComment"), onEdit)
      : <p className="comment-content">{renderCommentContent(comment.content)}</p>}
    {unreadCommentMentionId && <div className="comment-mention"><span><AtSign aria-hidden size={12} />{t("editor.mentionedYou")}</span><button type="button" onClick={(event) => void markRead(unreadCommentMentionId, event)}>{t("editor.markMentionRead")}</button></div>}
    {comment.replies.length > 0 && <div className="comment-replies">
      {visibleReplies.canToggle && <button type="button" className="comment-replies-toggle"
        aria-expanded={visibleReplies.expanded} aria-controls={repliesId}
        onClick={(event) => { event.stopPropagation(); onReplyExpansionChange(!visibleReplies.expanded); }}>
        {visibleReplies.expanded ? <ChevronUp size={13} aria-hidden /> : <ChevronDown size={13} aria-hidden />}
        {visibleReplies.expanded ? t("editor.hideEarlierReplies") : t("editor.showEarlierReplies", { count: visibleReplies.hiddenCount })}
      </button>}
      <div className="comment-replies-list" id={repliesId}>{visibleReplies.replies.map((reply) => {
      const unreadMentionId = unreadReplyMentionIds?.get(reply.id);
      const editKey: CommentDraftKey = `edit-reply:${reply.id}`;
      const editing = drafts[editKey]?.open && reply.authorId === currentUserId;
      return <div data-comment-reply-id={reply.id} className={`comment-reply${highlightedReplyId === reply.id ? " mention-target" : ""}`} key={reply.id}>
        <header>
          <span className={`comment-author${highlightReplyParticipants && selectedParticipantIds?.has(reply.authorId) ? " participant-match" : ""}`}><strong>{reply.authorDisplayName ?? reply.authorUsername ?? t("editor.deletedUser")}</strong>{reply.authorUsername && <small>@{reply.authorUsername}</small>}</span>
          <span className="comment-header-actions">
            <span className="comment-times"><time dateTime={reply.createdAt} title={new Date(reply.createdAt).toISOString()}>{formatTime(reply.createdAt)}</time>{reply.editedAt && <small>{t("editor.editedAt", { time: formatTime(reply.editedAt) })}</small>}</span>
            {reply.authorId === currentUserId && !editing && <CommentActionsMenu kind="reply"
              disabled={submittingForm || toggling}
              onEdit={() => openDraft(editKey, reply.content)}
              onDelete={() => setDeleteReplyId(reply.id)} />}
          </span>
        </header>
        {editing ? draftForm(editKey, t("editor.editReply"), (content) => onEditReply(reply.id, content))
          : <p className="comment-content">{renderCommentContent(reply.content)}</p>}
        {unreadMentionId && <div className="comment-mention"><span><AtSign aria-hidden size={12} />{t("editor.mentionedYou")}</span><button type="button" onClick={(event) => void markRead(unreadMentionId, event)}>{t("editor.markMentionRead")}</button></div>}
      </div>;
    })}</div></div>}
    {comment.resolved && comment.resolvedAt && <div className="comment-resolution">
      <CheckCircle2 size={12} aria-hidden />
      <span><Trans i18nKey="editor.resolvedBy"
        values={{ user: comment.resolvedByDisplayName ?? comment.resolvedByUsername ?? t("editor.deletedUser") }}
        components={{ user: <strong className="comment-resolution-user" /> }} />
        {comment.resolvedByUsername && <small className="comment-resolution-user"> @{comment.resolvedByUsername}</small>}
        {" · "}<time dateTime={comment.resolvedAt}>{formatTime(comment.resolvedAt)}</time>
      </span>
    </div>}
    <div className="comment-actions">
      <button className="resolve" disabled={toggling || submittingForm} aria-busy={toggling} onClick={(event) => {
        event.stopPropagation();
        if (toggling) return;
        setToggling(true);
        void onToggle().finally(() => setToggling(false));
      }}>{comment.resolved ? <RotateCcw size={13} /> : <CheckCircle2 size={13} />}{comment.resolved ? t("editor.reopen") : t("editor.resolve")}</button>
      <button className="reply-action" disabled={submittingForm || toggling} onClick={(event) => {
        event.stopPropagation();
        if (replyDraft?.open) draftStore.hide(comment.id, "reply");
        else openDraft("reply");
      }}><Reply size={13} />{t(replyDraft?.content && !replyDraft.open ? "editor.resumeReply" : "editor.reply")}</button>
    </div>
    {draftForm("reply", t("editor.reply"), onReply)}
  </article><ConfirmDialog open={deleteCommentOpen} title={t("editor.deleteCommentTitle")} description={t("editor.deleteCommentDescription", { count: comment.replies.length })} confirmLabel={t("common.delete")} danger onCancel={() => setDeleteCommentOpen(false)} onConfirm={() => void onDelete().then((deleted) => { if (deleted) setDeleteCommentOpen(false); })} /><ConfirmDialog open={Boolean(deleteReplyId)} title={t("editor.deleteReplyTitle")} description={t("editor.deleteReplyDescription")} confirmLabel={t("common.delete")} danger onCancel={() => setDeleteReplyId(null)} onConfirm={() => { if (deleteReplyId) void onDeleteReply(deleteReplyId).then((deleted) => { if (deleted) setDeleteReplyId(null); }); }} /></>;
}

interface ShareMember { id: string; username: string; displayName?: string; permission: "read" | "edit" }

export function ShareDialog({ open, onOpenChange, project, projectId }: {
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
    } catch (error) { setError(errorMessage(error)); }
  };
  useEffect(() => { if (open) void load(); }, [open, projectId]);
  const addMember = async () => {
    if (!userId) return;
    try {
      await api(`/api/projects/${projectId}/members/${userId}`, { method: "PUT", body: JSON.stringify({ permission }) });
      setUserId(""); setPermission("read"); await load();
    } catch (error) { setError(errorMessage(error)); }
  };
  const changePermission = async (member: ShareMember, next: "read" | "edit") => {
    try {
      await api(`/api/projects/${projectId}/members/${member.id}`, { method: "PUT", body: JSON.stringify({ permission: next }) });
      await load();
    } catch (error) { setError(errorMessage(error)); }
  };
  const removeMember = async () => {
    if (!removeTarget) return;
    try {
      await api(`/api/projects/${projectId}/members/${removeTarget.id}`, { method: "DELETE" });
      setRemoveTarget(null); await load();
    } catch (error) { setError(errorMessage(error)); }
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
