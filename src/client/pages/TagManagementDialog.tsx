import { useEffect, useState } from "react";
import { Check, LoaderCircle, Pencil, Plus, Trash2, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { api } from "../api";
import { ConfirmDialog, Modal } from "../Dialog";
import { errorMessage } from "../errors";
import type { ProjectTag, TagColor } from "../types";

export interface ManagedProjectTag extends ProjectTag {
  projectCount: number;
}

const tagColors: TagColor[] = ["red", "orange", "yellow", "green", "blue", "purple", "gray"];

function sortTags<T extends ProjectTag>(tags: T[]): T[] {
  return [...tags].sort((left, right) => left.name.localeCompare(right.name));
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/** Manage one user's private project-tag catalog without reloading the dashboard. */
export function TagManagementDialog({
  open,
  onOpenChange,
  onTagCreated,
  onTagUpdated,
  onTagDeleted
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onTagCreated: (tag: ProjectTag) => void;
  onTagUpdated: (tag: ProjectTag) => void;
  onTagDeleted: (tagId: string) => void;
}) {
  const { t } = useTranslation();
  const [tags, setTags] = useState<ManagedProjectTag[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [newName, setNewName] = useState("");
  const [newColor, setNewColor] = useState<TagColor>("blue");
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const [editingColor, setEditingColor] = useState<TagColor>("blue");
  const [savingId, setSavingId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ManagedProjectTag | null>(null);
  const [deleteError, setDeleteError] = useState("");
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setLoading(true);
    setError("");
    api<{ tags: ManagedProjectTag[] }>("/api/tags/management", { signal: controller.signal })
      .then((result) => setTags(sortTags(result.tags)))
      .catch((requestError) => { if (!isAbortError(requestError)) setError(errorMessage(requestError)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [open]);

  const createTag = async () => {
    if (!newName.trim() || creating) return;
    setCreating(true);
    setError("");
    try {
      const result = await api<{ tag: ProjectTag }>("/api/tags", {
        method: "POST",
        body: JSON.stringify({ name: newName, color: newColor })
      });
      setTags((current) => sortTags([...current, { ...result.tag, projectCount: 0 }]));
      onTagCreated(result.tag);
      setNewName("");
      setNewColor("blue");
    } catch (requestError) { setError(errorMessage(requestError)); }
    finally { setCreating(false); }
  };

  const beginEdit = (tag: ManagedProjectTag) => {
    setEditingId(tag.id);
    setEditingName(tag.name);
    setEditingColor(tag.color);
    setError("");
  };

  const saveEdit = async (tag: ManagedProjectTag) => {
    if (!editingName.trim() || savingId) return;
    setSavingId(tag.id);
    setError("");
    try {
      const result = await api<{ tag: ProjectTag }>(`/api/tags/${tag.id}`, {
        method: "PATCH",
        body: JSON.stringify({ name: editingName, color: editingColor })
      });
      const updated: ManagedProjectTag = { ...result.tag, projectCount: tag.projectCount };
      setTags((current) => sortTags(current.map((item) => item.id === tag.id ? updated : item)));
      onTagUpdated(result.tag);
      setEditingId(null);
    } catch (requestError) { setError(errorMessage(requestError)); }
    finally { setSavingId(null); }
  };

  const removeTag = async () => {
    if (!deleteTarget || deleting) return;
    setDeleting(true);
    setDeleteError("");
    try {
      await api<{ deletedId: string; projectCount: number }>(`/api/tags/${deleteTarget.id}`, { method: "DELETE" });
      setTags((current) => current.filter((tag) => tag.id !== deleteTarget.id));
      onTagDeleted(deleteTarget.id);
      setDeleteTarget(null);
      if (editingId === deleteTarget.id) setEditingId(null);
    } catch (requestError) { setDeleteError(errorMessage(requestError)); }
    finally { setDeleting(false); }
  };

  const busy = creating || savingId !== null || deleting;
  const close = (next: boolean) => {
    if (!next && busy) return;
    if (!next) {
      setError("");
      setDeleteError("");
      setEditingId(null);
    }
    onOpenChange(next);
  };

  return <><Modal
    open={open}
    title={t("tags.manage")}
    description={t("tags.manageDescription")}
    wide
    className="tag-management-modal"
    onOpenChange={close}
    footer={<button onClick={() => close(false)} disabled={busy}>{t("common.close")}</button>}
  >
    <div className="tag-management">
      {error && <p className="error dialog-error" role="alert">{error}</p>}
      <div className="tag-management-create">
        <label className="tag-management-field">
          <span>{t("tags.name")}</span>
          <input
            autoFocus
            value={newName}
            maxLength={32}
            placeholder={t("tags.name")}
            onChange={(event) => { setNewName(event.target.value); setError(""); }}
            onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void createTag(); } }}
          />
        </label>
        <label className="tag-management-field tag-management-color">
          <span>{t("tags.color")}</span>
          <select value={newColor} onChange={(event) => setNewColor(event.target.value as TagColor)}>
            {tagColors.map((color) => <option key={color} value={color}>{t(`tags.${color}`)}</option>)}
          </select>
        </label>
        <button type="button" className="primary" disabled={!newName.trim() || creating} aria-busy={creating} onClick={() => void createTag()}>
          {creating ? <LoaderCircle className="spin" size={14} /> : <Plus aria-hidden size={14} />}
          {t("tags.createInManager")}
        </button>
      </div>

      {loading ? <div className="tag-management-loading"><LoaderCircle className="spin" size={16} />{t("common.loading")}</div>
        : tags.length === 0 ? <p className="tag-management-empty">{t("tags.noTags")}</p>
          : <div className="tag-management-list">
            {tags.map((tag) => {
              const editing = editingId === tag.id;
              const saving = savingId === tag.id;
              return <article key={tag.id} className={`tag-management-item${editing ? " editing" : ""}`}>
                <div className="tag-management-item-main">
                  <span className={`tag-dot tag-${tag.color}`} aria-hidden="true" />
                  <div>
                    <strong title={tag.name}>{tag.name}</strong>
                    <small>{t("tags.projectCount", { count: tag.projectCount })}</small>
                  </div>
                </div>
                <div className="tag-management-item-actions">
                  <button type="button" title={t("tags.edit")} aria-label={t("tags.edit")} disabled={busy && !editing} onClick={() => beginEdit(tag)}><Pencil aria-hidden size={14} /></button>
                  <button type="button" className="danger-text" title={t("common.delete")} aria-label={t("common.delete")} disabled={busy} onClick={() => { setDeleteTarget(tag); setDeleteError(""); }}><Trash2 aria-hidden size={14} /></button>
                </div>
                {editing && <div className="tag-management-edit">
                  <label className="tag-management-field">
                    <span>{t("tags.rename")}</span>
                    <input
                      value={editingName}
                      maxLength={32}
                      onChange={(event) => { setEditingName(event.target.value); setError(""); }}
                      onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void saveEdit(tag); } }}
                    />
                  </label>
                  <label className="tag-management-field tag-management-color">
                    <span>{t("tags.color")}</span>
                    <select value={editingColor} onChange={(event) => { setEditingColor(event.target.value as TagColor); setError(""); }}>
                      {tagColors.map((color) => <option key={color} value={color}>{t(`tags.${color}`)}</option>)}
                    </select>
                  </label>
                  <div className="tag-management-edit-actions">
                    <button type="button" disabled={saving} onClick={() => { setEditingId(null); setError(""); }}><X aria-hidden size={14} />{t("common.cancel")}</button>
                    <button type="button" className="primary" disabled={!editingName.trim() || saving} aria-busy={saving} onClick={() => void saveEdit(tag)}>
                      {saving ? <LoaderCircle className="spin" size={14} /> : <Check aria-hidden size={14} />}{t("common.save")}
                    </button>
                  </div>
                </div>}
              </article>;
            })}
          </div>}
    </div>
  </Modal>
  <ConfirmDialog
    open={Boolean(deleteTarget)}
    title={t("tags.deleteTitle")}
    description={t("tags.deleteDescription", { tag: deleteTarget?.name ?? "", count: deleteTarget?.projectCount ?? 0 })}
    confirmLabel={deleting ? t("common.loading") : t("common.delete")}
    danger
    busy={deleting}
    error={deleteError}
    onCancel={() => { if (!deleting) { setDeleteTarget(null); setDeleteError(""); } }}
    onConfirm={() => void removeTag()}
  />
  </>;
}
