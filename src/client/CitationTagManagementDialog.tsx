import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, LoaderCircle, Pencil, Plus, Trash2, X } from "lucide-react";
import { api } from "./api";
import { ConfirmDialog, Modal } from "./Dialog";
import { errorMessage } from "./errors";
import type { CitationLibraryTag, TagColor } from "./types";

const colors: TagColor[] = ["red", "orange", "yellow", "green", "blue", "purple", "gray"];

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
  const [notice, setNotice] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<CitationLibraryTag | null>(null);
  const [deleteError, setDeleteError] = useState("");
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), 2000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const save = async (tag?: CitationLibraryTag) => {
    const nextName = (tag ? editName : name).trim();
    if (busy || !nextName) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const result = await api<{ tag: CitationLibraryTag; created?: boolean }>(tag ? `/api/citations/tags/${encodeURIComponent(tag.id)}` : "/api/citations/tags", {
        method: tag ? "PATCH" : "POST",
        body: JSON.stringify({ name: nextName, color: tag ? editColor : color })
      });
      onUpdated(result.tag);
      if (tag) setEditing(null);
      else setName("");
      setNotice(t(tag ? "citationLibrary.tagsUpdated" : result.created === false ? "citationTagManagement.exists" : "citationLibrary.tagCreated"));
    } catch (requestError) { setError(errorMessage(requestError)); }
    finally { setBusy(false); }
  };

  const remove = async () => {
    if (!deleteTarget || busy) return;
    setBusy(true); setDeleteError(""); setNotice("");
    try {
      await api(`/api/citations/tags/${encodeURIComponent(deleteTarget.id)}`, { method: "DELETE" });
      onDeleted(deleteTarget.id);
      if (editing?.id === deleteTarget.id) setEditing(null);
      setDeleteTarget(null);
      setNotice(t("citationTagManagement.deleted"));
    } catch (requestError) { setDeleteError(errorMessage(requestError)); }
    finally { setBusy(false); }
  };

  const colorOptions = colors.map((value) => <option key={value} value={value}>{t(`tags.${value}`)}</option>);
  return <><Modal open wide className="tag-management-modal" title={t("citationTagManagement.title")} description={t("citationTagManagement.description")} onOpenChange={(open) => { if (!open && !busy) onClose(); }} footer={<button disabled={busy} onClick={onClose}>{t("common.close")}</button>}>
    <div className="tag-management">
      {error && <p className="error dialog-error" role="alert">{error}</p>}
      {notice && <p className="citation-library-notice" role="status"><Check size={14} />{notice}<button aria-label={t("common.close")} onClick={() => setNotice("")}><X size={13} /></button></p>}
      <fieldset disabled={busy} className="citation-tag-management-fields">
        <form className="tag-management-create" onSubmit={(event) => { event.preventDefault(); void save(); }}>
          <label className="tag-management-field"><span>{t("tags.name")}</span><input autoFocus maxLength={32} value={name} placeholder={t("citationLibrary.newTagPlaceholder")} onChange={(event) => setName(event.target.value)} /></label>
          <label className="tag-management-field tag-management-color"><span>{t("tags.color")}</span><select value={color} onChange={(event) => setColor(event.target.value as TagColor)}>{colorOptions}</select></label>
          <button type="submit" className="primary" disabled={!name.trim()}>{busy ? <LoaderCircle className="spin" size={14} /> : <Plus size={14} />}{t("citationLibrary.createTag")}</button>
        </form>
        {tags.length === 0 ? <p className="tag-management-empty">{t("citationLibrary.noTags")}</p> : <div className="tag-management-list">{tags.map((tag) => <article key={tag.id} className={`tag-management-item${editing?.id === tag.id ? " editing" : ""}`}>
          <div className="tag-management-item-main"><span className={`tag-dot tag-${tag.color}`} aria-hidden /><strong title={tag.name}>{tag.name}</strong></div>
          <div className="tag-management-item-actions">
            <button type="button" aria-label={t("citationTagManagement.edit", { tag: tag.name })} onClick={() => { setEditing(tag); setEditName(tag.name); setEditColor(tag.color); setError(""); }}><Pencil size={14} /></button>
            <button type="button" className="danger-text" aria-label={t("citationTagManagement.delete", { tag: tag.name })} onClick={() => { setDeleteTarget(tag); setDeleteError(""); }}><Trash2 size={14} /></button>
          </div>
          {editing?.id === tag.id && <form className="tag-management-edit" onSubmit={(event) => { event.preventDefault(); void save(tag); }}>
            <label className="tag-management-field"><span>{t("tags.rename")}</span><input maxLength={32} value={editName} onChange={(event) => setEditName(event.target.value)} /></label>
            <label className="tag-management-field tag-management-color"><span>{t("tags.color")}</span><select value={editColor} onChange={(event) => setEditColor(event.target.value as TagColor)}>{colorOptions}</select></label>
            <div className="tag-management-edit-actions"><button type="button" onClick={() => { setEditing(null); setError(""); }}>{t("common.cancel")}</button><button type="submit" className="primary" disabled={!editName.trim()}><Check size={14} />{t("common.save")}</button></div>
          </form>}
        </article>)}</div>}
      </fieldset>
    </div>
  </Modal><ConfirmDialog open={Boolean(deleteTarget)} title={t("tags.deleteTitle")} description={t("citationTagManagement.deleteDescription", { tag: deleteTarget?.name ?? "" })} confirmLabel={t("common.delete")} danger busy={busy} error={deleteError} onCancel={() => { if (!busy) setDeleteTarget(null); }} onConfirm={() => void remove()} /></>;
}
