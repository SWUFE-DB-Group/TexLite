import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { Trans, useTranslation } from "react-i18next";
import { AtSign, Check, CheckCircle2, ChevronRight, ChevronUp, LoaderCircle, RotateCcw, Trash2, UserPlus, Users } from "lucide-react";
import { api } from "../api";
import { ConfirmDialog, Modal } from "../Dialog";
import { errorMessage } from "../errors";
import { formatRelativeTime, useRelativeTimeNow } from "../relativeTime";
import { formatDateTime } from "../dateTime";
import type { Comment, Project } from "../types";
import { CommentActionsMenu } from "./CommentActionsMenu";
import { CommentForm } from "./CommentForm";
import { CommentDraftStore, type CommentDraftKey } from "./commentDrafts";
import { commentReplyVisibility } from "./commentReplyVisibility";
import { prepareCommentDeletionEffect } from "./commentDeletionEffect";
import { UserAvatar } from "../UserAvatar";
import { ShareUserPicker, type ShareUser } from "./ShareUserPicker";

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

function CommentIdentity({ userId, avatarStyle, name, username, highlighted, children }: {
  userId: string | null; avatarStyle?: string | null;
  name: string; username: string | null; highlighted?: boolean; children: ReactNode;
}) {
  return <span className="comment-identity">
    <UserAvatar userId={userId} name={name} username={username} avatarStyle={avatarStyle} className="comment-avatar" />
    <span className="comment-author-details">
      <span className={`comment-author${highlighted ? " participant-match" : ""}`}><strong data-tooltip={username ? `@${username}` : undefined} data-texlite-tooltip-always>{name}</strong></span>
      {children}
    </span>
  </span>;
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
  const { t, i18n } = useTranslation();
  const now = useRelativeTimeNow();
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
  const [deleteError, setDeleteError] = useState("");
  const threadElement = useRef<HTMLElement>(null);
  const deletingRef = useRef(false);
  const [deleting, setDeleting] = useState(false);
  const confirmDelete = async (replyId: string | null) => {
    if (deletingRef.current) return;
    deletingRef.current = true;
    setDeleting(true);
    setDeleteError("");
    const element = replyId ? threadElement.current?.querySelector<HTMLElement>(`[data-comment-reply-id="${replyId}"]`) ?? null : threadElement.current;
    const playEffect = prepareCommentDeletionEffect(element);
    try {
      const deleted = replyId ? await onDeleteReply(replyId) : await onDelete();
      if (!deleted) { setDeleteError(t("editor.commentDeleteFailed")); return; }
      if (replyId) setDeleteReplyId(null);
      else setDeleteCommentOpen(false);
      playEffect();
    } catch (error) { setDeleteError(errorMessage(error)); }
    finally {
      deletingRef.current = false;
      setDeleting(false);
    }
  };
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
  const relativeTime = (value: string) => formatRelativeTime(value, i18n.resolvedLanguage ?? "en", now, (key, options) => t(key, options));
  const formatTime = (value: string) => {
    return formatDateTime(value, i18n.resolvedLanguage, {
      year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit"
    });
  };
  const timestamp = (value: string) => <time dateTime={value} data-tooltip={formatTime(value)} data-texlite-tooltip-always>{relativeTime(value)}</time>;
  const times = (createdAt: string, editedAt: string | null) => <span className="comment-times">
    {timestamp(createdAt)}
    {editedAt && <small data-tooltip={t("editor.editedAt", { time: formatTime(editedAt) })} data-texlite-tooltip-always>{t("editor.commentEdited")}</small>}
  </span>;
  const markRead = async (mentionId: string, event: ReactMouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    // Reading an old mention must not make that reply disappear immediately.
    onReplyExpansionChange(true);
    await onMarkMentionRead(mentionId);
  };
  return <><article ref={threadElement} data-comment-id={comment.id} className={`comment-thread${comment.resolved ? " resolved" : ""}${comment.orphaned ? " orphaned" : ""}${highlightedComment ? " mention-target" : ""}${currentComment ? " review-current" : ""}`} onFocusCapture={onActivate} onClick={() => { if (!window.getSelection()?.toString()) onFocus(); }}>
    <header className="comment-header">
      <CommentIdentity userId={comment.authorId} avatarStyle={comment.authorAvatarStyle} name={comment.authorDisplayName ?? username ?? t("editor.deletedUser")} username={username} highlighted={selectedParticipantIds?.has(comment.authorId)}>
        {times(comment.createdAt, comment.editedAt)}
      </CommentIdentity>
      <span className="comment-header-actions">
        <button type="button" className="resolve" disabled={toggling || submittingForm} aria-busy={toggling}
          aria-label={t(comment.resolved ? "editor.reopen" : "editor.resolve")}
          data-tooltip={t(comment.resolved ? "editor.reopen" : "editor.resolve")} data-texlite-tooltip-always
          onClick={(event) => {
            event.stopPropagation();
            if (toggling) return;
            setToggling(true);
            void onToggle().finally(() => setToggling(false));
          }}>
          {toggling ? <LoaderCircle className="spin" size={15} aria-hidden /> : comment.resolved ? <RotateCcw size={15} aria-hidden /> : <Check size={16} aria-hidden />}
        </button>
        {comment.authorId === currentUserId && !commentEditDraft?.open && <CommentActionsMenu kind="comment"
          disabled={submittingForm || toggling}
          onEdit={() => openDraft("edit-comment", comment.content)}
          onDelete={() => { setDeleteError(""); setDeleteCommentOpen(true); }} />}
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
        {visibleReplies.expanded ? <ChevronUp size={12} aria-hidden /> : <ChevronRight size={12} aria-hidden />}
        {visibleReplies.expanded ? t("editor.hideEarlierReplies") : t("editor.showEarlierReplies", { count: visibleReplies.hiddenCount })}
      </button>}
      <div className="comment-replies-list" id={repliesId}>{visibleReplies.replies.map((reply) => {
      const unreadMentionId = unreadReplyMentionIds?.get(reply.id);
      const editKey: CommentDraftKey = `edit-reply:${reply.id}`;
      const editing = drafts[editKey]?.open && reply.authorId === currentUserId;
      return <div data-comment-reply-id={reply.id} className={`comment-reply${highlightedReplyId === reply.id ? " mention-target" : ""}`} key={reply.id}>
        <header>
          <CommentIdentity userId={reply.authorId} avatarStyle={reply.authorAvatarStyle} name={reply.authorDisplayName ?? reply.authorUsername ?? t("editor.deletedUser")} username={reply.authorUsername} highlighted={highlightReplyParticipants && selectedParticipantIds?.has(reply.authorId)}>
            {times(reply.createdAt, reply.editedAt)}
          </CommentIdentity>
          <span className="comment-header-actions">
            {reply.authorId === currentUserId && !editing && <CommentActionsMenu kind="reply"
              disabled={submittingForm || toggling}
              onEdit={() => openDraft(editKey, reply.content)}
              onDelete={() => { setDeleteError(""); setDeleteReplyId(reply.id); }} />}
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
        components={{ user: <strong className="comment-resolution-user" data-tooltip={comment.resolvedByUsername ? `@${comment.resolvedByUsername}` : undefined} data-texlite-tooltip-always /> }} />
        {" · "}{timestamp(comment.resolvedAt)}
      </span>
    </div>}
    {!replyDraft?.open && <button type="button" className="reply-action" disabled={submittingForm || toggling} onClick={(event) => {
        event.stopPropagation();
        openDraft("reply");
      }}>{t("editor.replyPrompt")}</button>}
    {draftForm("reply", t("editor.reply"), onReply)}
  </article><ConfirmDialog open={deleteCommentOpen} title={t("editor.deleteCommentTitle")} description={t("editor.deleteCommentDescription")} confirmLabel={t("common.delete")} danger busy={deleting} error={deleteError} onCancel={() => setDeleteCommentOpen(false)} onConfirm={() => void confirmDelete(null)} /><ConfirmDialog open={Boolean(deleteReplyId)} title={t("editor.deleteReplyTitle")} description={t("editor.deleteReplyDescription")} confirmLabel={t("common.delete")} danger busy={deleting} error={deleteError} onCancel={() => setDeleteReplyId(null)} onConfirm={() => { if (deleteReplyId) void confirmDelete(deleteReplyId); }} /></>;
}

interface ShareMember { id: string; username: string; displayName?: string; avatarStyle?: string | null; permission: "read" | "edit" }

export function ShareDialog({ open, onOpenChange, project, projectId }: {
  open: boolean; onOpenChange: (open: boolean) => void; project: Project; projectId: string;
}) {
  const { t } = useTranslation();
  const [members, setMembers] = useState<ShareMember[]>([]);
  const [users, setUsers] = useState<ShareUser[]>([]);
  const [userId, setUserId] = useState("");
  const [permission, setPermission] = useState<"read" | "edit">("read");
  const [removeTarget, setRemoveTarget] = useState<ShareMember | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const view = useRef<AbortController | null>(null);
  const pending = useRef<AbortController | null>(null);
  const shareRef = useRef<HTMLDivElement>(null);
  const canManage = project.permission === "owner";
  const load = useCallback(async (signal: AbortSignal) => {
    const [memberResult, userResult] = await Promise.all([
      api<{ members: ShareMember[] }>(`/api/projects/${projectId}/members`, { signal }),
      canManage ? api<{ users: ShareUser[] }>("/api/users", { signal }) : Promise.resolve({ users: [] })
    ]);
    if (signal.aborted) return;
    setMembers(memberResult.members);
    setUsers(userResult.users.filter((candidate) => candidate.id !== project.ownerId));
  }, [projectId, project.ownerId, canManage]);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController(); view.current = controller;
    setUserId(""); setPermission("read"); setRemoveTarget(null); setError("");
    setUsers([]); setMembers([]); setBusy(false); setLoading(true);
    void load(controller.signal).catch((reason) => {
      if (!controller.signal.aborted) setError(errorMessage(reason));
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => { controller.abort(); if (view.current === controller) view.current = null; };
  }, [open, load]);
  const mutate = async (action: (signal: AbortSignal) => Promise<unknown>) => {
    const controller = view.current;
    if (!canManage || !controller || controller.signal.aborted || pending.current === controller) return;
    pending.current = controller; setBusy(true); setError("");
    try {
      await action(controller.signal);
      if (!controller.signal.aborted) await load(controller.signal);
    } catch (reason) { if (!controller.signal.aborted) setError(errorMessage(reason)); }
    finally {
      if (pending.current === controller) pending.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  };
  const availableUsers = users.filter((candidate) => !members.some((member) => member.id === candidate.id));
  const addMember = async () => {
    if (!availableUsers.some((candidate) => candidate.id === userId)) return;
    await mutate(async (signal) => {
      await api(`/api/projects/${projectId}/members/${userId}`, { method: "PUT", body: JSON.stringify({ permission }), signal });
      if (!signal.aborted) { setUserId(""); setPermission("read"); }
    });
  };
  const changePermission = async (member: ShareMember, next: "read" | "edit") => {
    await mutate((signal) => api(`/api/projects/${projectId}/members/${member.id}`, { method: "PUT", body: JSON.stringify({ permission: next }), signal }));
  };
  const removeMember = async () => {
    if (!removeTarget) return;
    await mutate(async (signal) => {
      await api(`/api/projects/${projectId}/members/${removeTarget.id}`, { method: "DELETE", signal });
      if (!signal.aborted) setRemoveTarget(null);
    });
  };
  return <><Modal open={open} wide className="share-dialog-modal" title={t("projectSettings.share")} description={t("projectSettings.shareDescription")} onOpenChange={(next) => { if (!busy) onOpenChange(next); }}
    onEscapeKeyDown={(event) => {
      // The first Escape dismisses the user list, not the owning share dialog.
      if (shareRef.current?.querySelector('[role="combobox"][aria-expanded="true"]')) event.preventDefault();
    }} footer={<button disabled={busy} onClick={() => onOpenChange(false)}>{t("common.close")}</button>}>
    <div className="share-dialog" ref={shareRef} aria-busy={loading || busy}>
      {error && !removeTarget && <p className="error" role="alert">{error}</p>}
      <div className="share-owner"><Users size={17} /><span><small>{t("projects.owner")}</small><strong>{project.ownerDisplayName ?? project.ownerUsername}</strong></span></div>
      {canManage && <div className="share-add">
        <ShareUserPicker key={projectId} users={availableUsers} value={userId} onChange={setUserId} disabled={loading || busy} />
        <label className="form-field">{t("common.permission")}<select disabled={loading || busy} value={permission} onChange={(event) => setPermission(event.target.value as "read" | "edit")}><option value="read">{t("common.readOnly")}</option><option value="edit">{t("common.readWrite")}</option></select></label>
        <button className="primary icon-button" disabled={loading || busy || !availableUsers.some((candidate) => candidate.id === userId)} onClick={() => void addMember()}>{busy ? <LoaderCircle className="spin" size={15} /> : <UserPlus size={15} />}{t("projectSettings.addMember")}</button>
      </div>}
      <div className="shared-members-heading"><strong>{t("projectSettings.members")}</strong><span>{members.length}</span></div>
      <div className="shared-members">{members.map((member) => <div className="shared-member" key={member.id}><span className="member-identity"><UserAvatar userId={member.id} name={member.displayName} username={member.username} avatarStyle={member.avatarStyle} className="member-avatar" /><span><strong>{member.displayName ?? member.username}</strong><small>@{member.username}</small></span></span><span className="member-controls"><select aria-label={t("common.permission")} disabled={!canManage || busy} value={member.permission} onChange={(event) => void changePermission(member, event.target.value as "read" | "edit")}><option value="read">{t("common.readOnly")}</option><option value="edit">{t("common.readWrite")}</option></select>{canManage && <button disabled={busy} className="icon-only danger-text" title={t("common.remove")} aria-label={t("common.remove")} onClick={() => { setError(""); setRemoveTarget(member); }}><Trash2 size={15} /></button>}</span></div>)}{loading ? <div className="share-empty" role="status"><LoaderCircle className="spin" size={20} /><span>{t("common.loading")}</span></div> : members.length === 0 && <div className="share-empty"><Users size={24} /><span>{t("projectSettings.noMembers")}</span></div>}</div>
    </div>
  </Modal><ConfirmDialog open={Boolean(removeTarget)} title={t("projectSettings.removeTitle")} description={t("projectSettings.removeDescription", { username: removeTarget?.username ?? "" })} confirmLabel={t("common.remove")} danger busy={busy} error={error} onCancel={() => { if (!busy) { setRemoveTarget(null); setError(""); } }} onConfirm={() => void removeMember()} /></>;
}
