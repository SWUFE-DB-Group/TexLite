import { useEffect, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { CheckCircle2, Pencil, Reply, RotateCcw, Save, Send, Trash2, UserPlus, Users } from "lucide-react";
import { api } from "../api";
import { ConfirmDialog, Modal } from "../Dialog";
import { errorMessage } from "../errors";
import i18n from "../i18n";
import type { Comment, Project } from "../types";

function submitOnShortcut(event: ReactKeyboardEvent<HTMLTextAreaElement>, submit: () => Promise<void>): void {
  if (!(event.ctrlKey || event.metaKey) || event.key !== "Enter" || event.nativeEvent.isComposing) return;
  event.preventDefault();
  event.stopPropagation();
  void submit();
}

export function CommentThread({ comment, currentUserId, onFocus, onToggle, onReply, onEdit, onDelete, onEditReply, onDeleteReply }: {
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
  const submitReply = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!replyContent.trim()) return;
    if (await onReply(replyContent)) { setReplyContent(""); setReplying(false); }
  };
  const submitCommentEdit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!commentContent.trim()) return;
    if (await onEdit(commentContent)) setEditingComment(false);
  };
  const submitReplyEdit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!editingReplyId || !replyEditContent.trim()) return;
    if (await onEditReply(editingReplyId, replyEditContent)) setEditingReplyId(null);
  };
  const username = comment.authorUsername;
  const formatTime = (value: string) => new Date(value).toLocaleString(i18n.resolvedLanguage);
  return <><article className={`comment-thread${comment.resolved ? " resolved" : ""}${comment.orphaned ? " orphaned" : ""}`} onClick={() => { if (!window.getSelection()?.toString()) onFocus(); }}>
    <header className="comment-header"><span className="comment-author"><strong>{comment.authorDisplayName ?? username ?? t("editor.deletedUser")}</strong>{username && <small>@{username}</small>}</span><span className="comment-times"><time dateTime={comment.createdAt} title={new Date(comment.createdAt).toISOString()}>{formatTime(comment.createdAt)}</time>{comment.editedAt && <small>{t("editor.editedAt", { time: formatTime(comment.editedAt) })}</small>}</span></header>
    <div className="comment-location">{comment.orphaned ? t("editor.orphaned") : t("editor.line", { line: comment.startLine })}</div>
    {comment.selectedText && <blockquote className="comment-selected-text">{comment.selectedText}</blockquote>}
    {editingComment ? <form className="comment-reply-form comment-edit-form" onSubmit={(event) => void submitCommentEdit(event)} onClick={(event) => event.stopPropagation()}><textarea autoFocus rows={4} value={commentContent} onChange={(event) => setCommentContent(event.target.value)} onKeyDown={(event) => submitOnShortcut(event, submitCommentEdit)} /><div><button type="button" onClick={() => setEditingComment(false)}>{t("common.cancel")}</button><button className="primary" type="submit" disabled={!commentContent.trim()}><Save size={13} />{t("editor.saveChanges")}</button></div></form> : <p className="comment-content">{comment.content}</p>}
    {comment.replies.length > 0 && <div className="comment-replies">{comment.replies.map((reply) => <div className="comment-reply" key={reply.id}><header><span className="comment-author"><strong>{reply.authorDisplayName ?? reply.authorUsername ?? t("editor.deletedUser")}</strong>{reply.authorUsername && <small>@{reply.authorUsername}</small>}</span><span className="comment-times"><time dateTime={reply.createdAt} title={new Date(reply.createdAt).toISOString()}>{formatTime(reply.createdAt)}</time>{reply.editedAt && <small>{t("editor.editedAt", { time: formatTime(reply.editedAt) })}</small>}</span></header>{editingReplyId === reply.id ? <form className="comment-reply-form comment-edit-form" onSubmit={(event) => void submitReplyEdit(event)} onClick={(event) => event.stopPropagation()}><textarea autoFocus rows={3} value={replyEditContent} onChange={(event) => setReplyEditContent(event.target.value)} onKeyDown={(event) => submitOnShortcut(event, submitReplyEdit)} /><div><button type="button" onClick={() => setEditingReplyId(null)}>{t("common.cancel")}</button><button className="primary" type="submit" disabled={!replyEditContent.trim()}><Save size={13} />{t("editor.saveChanges")}</button></div></form> : <p className="comment-content">{reply.content}</p>}{reply.authorId === currentUserId && editingReplyId !== reply.id && <div className="comment-owner-actions"><button title={t("editor.editReply")} aria-label={t("editor.editReply")} onClick={(event) => { event.stopPropagation(); setEditingReplyId(reply.id); setReplyEditContent(reply.content); }}><Pencil size={12} /></button><button className="danger-text" title={t("editor.deleteReply")} aria-label={t("editor.deleteReply")} onClick={(event) => { event.stopPropagation(); setDeleteReplyId(reply.id); }}><Trash2 size={12} /></button></div>}</div>)}</div>}
    <div className="comment-actions"><button className="resolve" onClick={(event) => { event.stopPropagation(); onToggle(); }}>{comment.resolved ? <RotateCcw size={13} /> : <CheckCircle2 size={13} />}{comment.resolved ? t("editor.reopen") : t("editor.resolve")}</button><button className="reply-action" onClick={(event) => { event.stopPropagation(); setReplying((current) => !current); }}><Reply size={13} />{t("editor.reply")}</button>{comment.authorId === currentUserId && !editingComment && <span className="comment-owner-actions"><button title={t("editor.editComment")} aria-label={t("editor.editComment")} onClick={(event) => { event.stopPropagation(); setCommentContent(comment.content); setEditingComment(true); }}><Pencil size={13} /></button><button className="danger-text" title={t("editor.deleteComment")} aria-label={t("editor.deleteComment")} onClick={(event) => { event.stopPropagation(); setDeleteCommentOpen(true); }}><Trash2 size={13} /></button></span>}</div>
    {replying && <form className="comment-reply-form" onSubmit={(event) => void submitReply(event)} onClick={(event) => event.stopPropagation()}><textarea autoFocus rows={3} value={replyContent} placeholder={t("editor.replyPlaceholder")} onChange={(event) => setReplyContent(event.target.value)} onKeyDown={(event) => submitOnShortcut(event, submitReply)} /><div><button type="button" onClick={() => { setReplying(false); setReplyContent(""); }}>{t("common.cancel")}</button><button className="primary" type="submit" disabled={!replyContent.trim()}><Send size={13} />{t("editor.sendReply")}</button></div></form>}
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
