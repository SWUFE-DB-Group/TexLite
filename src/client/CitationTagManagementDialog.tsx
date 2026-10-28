import { useState } from "react";
import { useTranslation } from "react-i18next";
import { LoaderCircle, Pencil, Plus, Trash2 } from "lucide-react";
import { api } from "./api";
import { ConfirmDialog, Modal } from "./Dialog";
import { errorMessage } from "./errors";
import { TagColorSelect } from "./TagColorSelect";
import { useSuccessNotice } from "./SuccessNotice";
import { SaveButton } from "./SaveButton";
import type { CitationLibraryTag, TagColor } from "./types";

export function CitationTagManagementDialog({ tags, onClose, onUpdated, onDeleted }: {
  tags: CitationLibraryTag[];
  onClose: () => void;
  onUpdated: (tag: CitationLibraryTag) => void;
  onDeleted: (id: string) => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [color, setColor] = useState<TagColor>("green");
  const [editing, setEditing] = useState<CitationLibraryTag | null>(null);
  const [editName, setEditName] = useState("");
  const [editColor, setEditColor] = useState<TagColor>("green");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const completedAction = useSuccessNotice();
  const [deleteTarget, setDeleteTarget] = useState<CitationLibraryTag | null>(null);
  const [deleteError, setDeleteError] = useState("");

  const save = async (tag?: CitationLibraryTag) => {
    const nextName = (tag ? editName : name).trim();
    if (busy || !nextName) return;
    setBusy(true); setError(""); completedAction.clear();
    try {
      const result = await api<{ tag: CitationLibraryTag; created?: boolean }>(tag ? `/api/citations/tags/${encodeURIComponent(tag.id)}` : "/api/citations/tags", {
        method: tag ? "PATCH" : "POST",
        body: JSON.stringify({ name: nextName, color: tag ? editColor : color })
      });
      onUpdated(result.tag);
      if (tag) setEditing(result.tag);
      else setName("");
      completedAction.show(tag ? `edit:${tag.id}` : result.created === false ? "exists" : "create");
    } catch (requestError) { setError(errorMessage(requestError)); }
    finally { setBusy(false); }
  };

  const remove = async () => {
    if (!deleteTarget || busy) return;
    setBusy(true); setDeleteError(""); completedAction.clear();
    try {
      await api(`/api/citations/tags/${encodeURIComponent(deleteTarget.id)}`, { method: "DELETE" });
      onDeleted(deleteTarget.id);
      if (editing?.id === deleteTarget.id) setEditing(null);
      setDeleteTarget(null);
    } catch (requestError) { setDeleteError(errorMessage(requestError)); }
    finally { setBusy(false); }
  };

  return <><Modal open wide className="tag-management-modal management-dialog" title={t("citationTagManagement.title")} description={t("citationTagManagement.description")} onOpenChange={(open) => { if (!open && !busy) onClose(); }} footer={<button disabled={busy} onClick={onClose}>{t("common.close")}</button>}>
    <div className="tag-management">
      {error && <p className="error dialog-error" role="alert">{error}</p>}
      <fieldset disabled={busy} className="citation-tag-management-fields">
        <form className="tag-management-create" onSubmit={(event) => { event.preventDefault(); void save(); }}>
          <label className="tag-management-field"><span>{t("tags.name")}</span><input autoFocus maxLength={32} value={name} placeholder={t("citationLibrary.newTagPlaceholder")} onChange={(event) => setName(event.target.value)} /></label>
          <label className="tag-management-field tag-management-color"><span>{t("tags.color")}</span><TagColorSelect value={color} onChange={setColor} disabled={busy} /></label>
          <button type="submit" className="primary" disabled={!name.trim()}>{busy ? <LoaderCircle className="spin" size={14} /> : <Plus size={14} />}<span role="status">{t(completedAction.message === "create" ? "common.done" : completedAction.message === "exists" ? "citationTagManagement.exists" : "citationLibrary.createTag")}</span></button>
        </form>
        {tags.length === 0 ? <p className="tag-management-empty">{t("citationLibrary.noTags")}</p> : <div className="tag-management-list">{tags.map((tag) => <article key={tag.id} className={`tag-management-item${editing?.id === tag.id ? " editing" : ""}`}>
          <div className="tag-management-item-main"><span className={`tag-dot tag-${tag.color}`} aria-hidden /><strong title={tag.name}>{tag.name}</strong></div>
          <div className="tag-management-item-actions">
            <button type="button" aria-label={t("citationTagManagement.edit", { tag: tag.name })} onClick={() => { setEditing(tag); setEditName(tag.name); setEditColor(tag.color); setError(""); }}><Pencil size={14} /></button>
            <button type="button" className="danger-text" aria-label={t("citationTagManagement.delete", { tag: tag.name })} onClick={() => { setDeleteTarget(tag); setDeleteError(""); }}><Trash2 size={14} /></button>
          </div>
          {editing?.id === tag.id && <form className="tag-management-edit" onSubmit={(event) => { event.preventDefault(); void save(tag); }}>
            <label className="tag-management-field"><span>{t("tags.rename")}</span><input maxLength={32} value={editName} onChange={(event) => setEditName(event.target.value)} /></label>
            <label className="tag-management-field tag-management-color"><span>{t("tags.color")}</span><TagColorSelect value={editColor} onChange={setEditColor} disabled={busy} /></label>
            <div className="tag-management-edit-actions"><button type="button" onClick={() => { setEditing(null); setError(""); }}>{t("common.cancel")}</button><SaveButton type="submit" saving={busy} feedback={completedAction.message === `edit:${tag.id}` ? t("editor.saved") : ""} disabled={!editName.trim()}>{t("common.save")}</SaveButton></div>
          </form>}
        </article>)}</div>}
      </fieldset>
    </div>
  </Modal><ConfirmDialog open={Boolean(deleteTarget)} title={t("tags.deleteTitle")} description={t("citationTagManagement.deleteDescription", { tag: deleteTarget?.name ?? "" })} confirmLabel={t("common.delete")} danger busy={busy} error={deleteError} onCancel={() => { if (!busy) setDeleteTarget(null); }} onConfirm={() => void remove()} /></>;
}
