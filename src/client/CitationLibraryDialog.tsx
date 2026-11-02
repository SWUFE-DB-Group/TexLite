import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { ArrowLeft, BookMarked, Check, ChevronLeft, ChevronRight, FolderOpen, LoaderCircle, Plus, Search, X } from "lucide-react";
import { ConfirmDialog, Modal } from "./Dialog";
import { api } from "./api";
import { errorMessage } from "./errors";
import { CitationTagFilters } from "./CitationTagFilters";
import { CitationCard } from "./CitationCard";
import { ProjectCitationLibrary } from "./ProjectCitationLibrary";
import { useSuccessNotice } from "./SuccessNotice";
import { SaveButton } from "./SaveButton";
import { CitationTagManagementDialog } from "./CitationTagManagementDialog";
import { parseSingleBibEntry } from "./citationLibrary";
import type { CitationLibraryEntry, CitationLibraryTag, ProjectListPagination } from "./types";
import type { CitationCollectionCatalog } from "../shared/citationCollections";
import { CitationCollections, CitationCollectionEditor } from "./CitationCollections";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Render the library as a full dashboard page instead of a modal. */
  page?: boolean;
  onBack?: () => void;
  currentFile?: string;
  currentSource?: string;
  readOnly?: boolean;
  currentUserId: string;
  maxBibtexBytes: number;
  onInsert?: (entry: CitationLibraryEntry) => boolean | Promise<boolean>;
}

export function CitationLibraryDialog(props: Props) {
  if (!props.page && props.onInsert) return <ProjectCitationLibrary open={props.open} onOpenChange={props.onOpenChange} currentFile={props.currentFile ?? ""}
    currentSource={props.currentSource ?? ""} readOnly={props.readOnly ?? false} currentUserId={props.currentUserId} maxBibtexBytes={props.maxBibtexBytes} onInsert={props.onInsert} />;
  return <CitationLibraryManager {...props} />;
}

function CitationLibraryManager({ open, onOpenChange, page = false, onBack, currentUserId, maxBibtexBytes }: Props) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [selectedTag, setSelectedTag] = useState("");
  const [selectedCollection, setSelectedCollection] = useState("");
  const [collectionCatalog, setCollectionCatalog] = useState<CitationCollectionCatalog>({ collections: [], total: 0, unfiled: 0 });
  const [collectionEditor, setCollectionEditor] = useState<CitationLibraryEntry | null>(null);
  const [entries, setEntries] = useState<CitationLibraryEntry[]>([]);
  const [pageNumber, setPageNumber] = useState(1);
  const [pagination, setPagination] = useState<ProjectListPagination>({ page: 1, pageSize: 60, total: 0, totalPages: 0 });
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [tags, setTags] = useState<CitationLibraryTag[]>([]);
  const [tagManagerOpen, setTagManagerOpen] = useState(false);
  const [tagEditor, setTagEditor] = useState<CitationLibraryEntry | null>(null);
  const [tagEditorIds, setTagEditorIds] = useState<string[]>([]);
  const [tagSaving, setTagSaving] = useState(false);
  const [loading, setLoading] = useState(false);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [editing, setEditing] = useState<CitationLibraryEntry | null>(null);
  const [editText, setEditText] = useState("");
  const [adding, setAdding] = useState(false);
  const [addText, setAddText] = useState("");
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<CitationLibraryEntry | null>(null);
  const [deleteError, setDeleteError] = useState("");
  const [error, setError] = useState("");
  const completedAction = useSuccessNotice();
  useEffect(() => { if (!open) setTagManagerOpen(false); }, [open]);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setLoading(true);
    const timer = window.setTimeout(() => {
      setLoading(true);
      setError("");
      const params = new URLSearchParams();
      if (query.trim()) params.set("q", query.trim());
      if (selectedTag) params.set("tag", selectedTag);
      if (selectedCollection) params.set("collection", selectedCollection);
      params.set("page", String(pageNumber));
      params.set("pageSize", "60");
      void api<{ entries: CitationLibraryEntry[]; pagination: ProjectListPagination }>(`/api/citations?${params.toString()}`, { signal: controller.signal })
        .then((result) => { if (!controller.signal.aborted) { setEntries(result.entries); setPagination(result.pagination); if (result.pagination.page !== pageNumber) setPageNumber(result.pagination.page); } })
        .catch((requestError) => {
          if (controller.signal.aborted || requestError instanceof Error && requestError.name === "AbortError") return;
          setError(errorMessage(requestError));
        })
        .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    }, query.trim() ? 180 : 0);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [open, query, selectedTag, selectedCollection, pageNumber, refreshNonce, currentUserId]);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    void api<CitationCollectionCatalog>("/api/citations/collections", { signal: controller.signal }).then((result) => {
      if (controller.signal.aborted) return;
      setCollectionCatalog(result);
      setSelectedCollection((id) => !id || id === "unfiled" || result.collections.some((folder) => folder.id === id) ? id : "");
    }).catch((reason) => { if (!controller.signal.aborted) setError(errorMessage(reason)); });
    return () => controller.abort();
  }, [open, currentUserId, refreshNonce]);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    void api<{ tags: CitationLibraryTag[] }>("/api/citations/tags", { signal: controller.signal })
      .then((result) => setTags(result.tags))
      .catch((requestError) => {
        if (!(requestError instanceof Error && requestError.name === "AbortError")) setError(errorMessage(requestError));
      });
    return () => controller.abort();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setSelectedTag("");
    setSelectedCollection("");
    setCollectionEditor(null);
    setPageNumber(1);
    setPagination({ page: 1, pageSize: 60, total: 0, totalPages: 0 });
    setEditing(null);
    setAdding(false);
    setAddText("");
    setTagEditor(null);
    setDeletingId(null);
    setDeleteTarget(null);
    setDeleteError("");
    setError("");
    completedAction.clear();
  }, [open, currentUserId]);

  const saveEdited = async () => {
    if (!editing) return;
    completedAction.clear();
    setSavingKey(editing.citationKey);
    setError("");
    try {
      const parsed = parseSingleBibEntry(editText, maxBibtexBytes);
      if (!parsed) {
        setError(t("citationErrors.invalid"));
        return;
      }
      const result = await api<{ entry: CitationLibraryEntry }>(`/api/citations/${encodeURIComponent(editing.id)}`, {
        method: "PATCH", body: JSON.stringify({
          bibtex: parsed.bibtex, citationKey: parsed.citationKey, entryType: parsed.entryType,
          title: parsed.title, authors: parsed.authors, year: parsed.year,
          expectedRevision: editing.revision
        })
      });
      setEntries((current) => [result.entry, ...current.filter((item) => item.id !== result.entry.id)]);
      setEditing((current) => current?.id === result.entry.id ? result.entry : current);
      completedAction.show(`edit:${result.entry.id}`);
      setPageNumber(1);
      setRefreshNonce((current) => current + 1);
    } catch (requestError) { setError(errorMessage(requestError)); }
    finally { setSavingKey(null); }
  };

  const saveNew = async () => {
    if (!addText.trim()) return;
    completedAction.clear();
    setSavingKey("__new__");
    setError("");
    try {
      const parsed = parseSingleBibEntry(addText, maxBibtexBytes);
      if (!parsed) {
        setError(t("citationErrors.invalid"));
        return;
      }
      const result = await api<{ entry: CitationLibraryEntry; updated: boolean }>("/api/citations", {
        method: "POST", body: JSON.stringify({
          bibtex: parsed.bibtex, citationKey: parsed.citationKey, entryType: parsed.entryType,
          title: parsed.title, authors: parsed.authors, year: parsed.year,
          collectionIds: selectedCollection && selectedCollection !== "unfiled" ? [selectedCollection] : undefined
        })
      });
      setEntries((current) => [result.entry, ...current.filter((item) => item.id !== result.entry.id && item.citationKey.toLowerCase() !== result.entry.citationKey.toLowerCase())]);
      setAdding(false);
      setAddText("");
      completedAction.show("add");
      setTagEditor(result.entry);
      setTagEditorIds(result.entry.tags.map((tag) => tag.id));
      setPageNumber(1);
      setRefreshNonce((current) => current + 1);
    } catch (requestError) { setError(errorMessage(requestError)); }
    finally { setSavingKey(null); }
  };

  const updateCatalogTag = (tag: CitationLibraryTag) => {
    setTags((current) => [...current.filter((item) => item.id !== tag.id), tag].sort((left, right) => left.name.localeCompare(right.name)));
    const updateEntry = (entry: CitationLibraryEntry) => ({ ...entry, tags: entry.tags.map((item) => item.id === tag.id ? tag : item) });
    setEntries((current) => current.map(updateEntry));
    setTagEditor((current) => current ? updateEntry(current) : null);
    setEditing((current) => current ? updateEntry(current) : null);
  };

  const deleteCatalogTag = (id: string) => {
    setTags((current) => current.filter((tag) => tag.id !== id));
    const updateEntry = (entry: CitationLibraryEntry) => ({ ...entry, tags: entry.tags.filter((tag) => tag.id !== id) });
    setEntries((current) => current.map(updateEntry));
    setTagEditor((current) => current ? updateEntry(current) : null);
    setEditing((current) => current ? updateEntry(current) : null);
    setTagEditorIds((current) => current.filter((tagId) => tagId !== id));
    if (selectedTag === id) { setSelectedTag(""); setPageNumber(1); }
  };

  const editTags = (entry: CitationLibraryEntry) => {
    completedAction.clear();
    setEditing(null);
    setAdding(false);
    setTagEditor(entry);
    setTagEditorIds(entry.tags.map((tag) => tag.id));
  };

  const saveTags = async () => {
    if (!tagEditor) return;
    completedAction.clear();
    setTagSaving(true);
    setError("");
    try {
      const result = await api<{ entry: CitationLibraryEntry }>(`/api/citations/${encodeURIComponent(tagEditor.id)}/tags`, {
        method: "PATCH", body: JSON.stringify({ tagIds: tagEditorIds, expectedRevision: tagEditor.revision })
      });
      setEntries((current) => current.map((entry) => entry.id === result.entry.id ? result.entry : entry));
      setTagEditor((current) => current?.id === result.entry.id ? result.entry : current);
      setTagEditorIds(result.entry.tags.map((tag) => tag.id));
      completedAction.show(`tags:${result.entry.id}`);
      setRefreshNonce((current) => current + 1);
    } catch (requestError) { setError(errorMessage(requestError)); }
    finally { setTagSaving(false); }
  };

  const deleteEntry = async (entry: CitationLibraryEntry) => {
    setDeletingId(entry.id);
    setDeleteError("");
    try {
      await api(`/api/citations/${encodeURIComponent(entry.id)}`, { method: "DELETE" });
      setEntries((current) => current.filter((item) => item.id !== entry.id));
      if (editing?.id === entry.id) setEditing(null);
      if (tagEditor?.id === entry.id) setTagEditor(null);
      setPageNumber(1);
      setRefreshNonce((current) => current + 1);
      setDeleteTarget(null);
    } catch (requestError) { setDeleteError(errorMessage(requestError)); }
    finally { setDeletingId(null); }
  };

  const selectedFolder = collectionCatalog.collections.find((folder) => folder.id === selectedCollection);
  const libraryBody = <div className="citation-library-layout">
    <CitationCollections catalog={collectionCatalog} selected={selectedCollection} onSelect={(id) => { setSelectedCollection(id); setPageNumber(1); }}
      onChanged={(id) => { if (id) { setSelectedCollection(id); setPageNumber(1); } setRefreshNonce((current) => current + 1); }}
      onDeleted={(id) => {
        if (selectedCollection === id) { setSelectedCollection(""); setPageNumber(1); }
        setRefreshNonce((current) => current + 1);
      }} />
    <div className="citation-library-dialog">
      {error && !(page && (tagEditor || editing)) && <p className="error dialog-error">{error}</p>}
        <div className="citation-library-scope-heading"><strong><FolderOpen size={15} aria-hidden />{selectedFolder?.name ?? t(selectedCollection === "unfiled" ? "citationFolders.unfiled" : "citationFolders.all")}</strong>
        </div>
        <div className="citation-library-search-row"><label className="citation-library-search"><Search size={15} /><input autoFocus placeholder={t("citationLibrary.searchPlaceholder")} value={query} onChange={(event) => { setQuery(event.target.value); setPageNumber(1); }} /><span>{t("citationLibrary.searchHint")}</span></label><button type="button" className="citation-add-entry-button" onClick={() => { completedAction.clear(); setAdding(true); setEditing(null); setTagEditor(null); }}><Plus size={14} /><span role="status">{t(completedAction.message === "add" ? "common.done" : "citationLibraryActions.addEntry")}</span></button></div>
        <CitationTagFilters tags={tags} selectedId={selectedTag} onSelect={(id) => { setSelectedTag(id); setPageNumber(1); }} onManage={() => setTagManagerOpen(true)} />
        {adding && <div className="citation-edit-panel"><div className="citation-edit-header"><div><strong>{t("citationLibraryActions.addEntryTitle")}</strong><small>{t("citationLibraryActions.addEntryDescription")}</small></div><button type="button" aria-label={t("common.close")} onClick={() => setAdding(false)}><X size={15} /></button></div><textarea autoFocus value={addText} onChange={(event) => setAddText(event.target.value)} placeholder={t("citationLibraryActions.addEntryPlaceholder")} spellCheck={false} rows={9} /><div className="citation-edit-actions"><button type="button" onClick={() => setAdding(false)}>{t("common.cancel")}</button><button type="button" className="primary" disabled={!addText.trim() || savingKey === "__new__"} onClick={() => void saveNew()}>{savingKey === "__new__" ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />}{t("citationLibraryActions.addEntry")}</button></div></div>}
        {loading && !editing && !tagEditor ? <div className="citation-library-empty"><LoaderCircle className="spin" size={22} /><span>{t("common.loading")}</span></div>
          : entries.length === 0 ? <div className="citation-library-empty"><BookMarked size={28} /><strong>{t("citationLibrary.emptyTitle")}</strong><span>{selectedCollection ? t("citationFolders.empty") : selectedTag ? t("citationLibrary.noTagMatches") : t("citationLibrary.emptyDescription")}</span></div>
          : <div className="citation-entry-list">{entries.map((entry) => <div className="citation-entry-item" key={entry.id}>
            <CitationCard entry={entry} selected={tagEditor?.id === entry.id || editing?.id === entry.id || collectionEditor?.id === entry.id}
              deleting={deletingId === entry.id}
              onEdit={entry.ownerId === currentUserId ? () => { completedAction.clear(); setTagEditor(null); setAdding(false); setEditing(entry); setEditText(entry.bibtex); } : undefined}
              onTags={entry.ownerId === currentUserId ? () => editTags(entry) : undefined}
              onCollections={entry.ownerId === currentUserId ? () => setCollectionEditor(entry) : undefined}
              onDelete={entry.ownerId === currentUserId ? () => { setDeleteTarget(entry); setDeleteError(""); } : undefined} t={t} />
            {!page && tagEditor?.id === entry.id && <CitationTagEditor feedback={completedAction.message === `tags:${tagEditor.id}` ? t("editor.saved") : ""} entry={tagEditor} tags={tags} selectedIds={tagEditorIds} saving={tagSaving} onClose={() => setTagEditor(null)} onToggle={(tagId) => setTagEditorIds((current) => current.includes(tagId) ? current.filter((id) => id !== tagId) : [...current, tagId])} onSave={() => void saveTags()} t={t} />}
            {!page && editing?.id === entry.id && <CitationEditPanel feedback={completedAction.message === `edit:${editing.id}` ? t("editor.saved") : ""} title={t("citationLibrary.editTitle", { key: editing.citationKey })} value={editText} saving={savingKey === editing.citationKey} onChange={setEditText} onClose={() => setEditing(null)} onSave={() => void saveEdited()} t={t} />}
          </div>)}</div>}
        {pagination.totalPages > 1 && <nav className="citation-library-pagination" aria-label={t("citationLibraryPagination.pageOf", { page: pagination.page, totalPages: pagination.totalPages, count: pagination.total })}><button type="button" disabled={pagination.page <= 1} onClick={() => setPageNumber((current) => Math.max(1, current - 1))}><ChevronLeft size={14} />{t("citationLibraryPagination.previous")}</button><span>{t("citationLibraryPagination.pageOf", { page: pagination.page, totalPages: pagination.totalPages, count: pagination.total })}</span><button type="button" disabled={pagination.page >= pagination.totalPages} onClick={() => setPageNumber((current) => Math.min(pagination.totalPages, current + 1))}>{t("citationLibraryPagination.next")}<ChevronRight size={14} /></button></nav>}
    </div>
    </div>;
  const deleteConfirmation = <ConfirmDialog
    open={Boolean(deleteTarget)}
    title={t("citationLibrary.deleteTitle")}
    description={t("citationLibrary.deleteDescription", { key: deleteTarget?.citationKey ?? "" })}
    confirmLabel={t("common.delete")}
    danger
    error={deleteError}
    busy={Boolean(deletingId)}
    onCancel={() => { setDeleteTarget(null); setDeleteError(""); }}
    onConfirm={() => {
      const target = deleteTarget;
      if (target) void deleteEntry(target);
    }}
  />;
  const tagManagement = open && tagManagerOpen && <CitationTagManagementDialog tags={tags} onClose={() => setTagManagerOpen(false)} onUpdated={updateCatalogTag} onDeleted={deleteCatalogTag} />;
  const collectionManagement = open && collectionEditor && <CitationCollectionEditor key={collectionEditor.id} entry={collectionEditor} catalog={collectionCatalog} onClose={() => setCollectionEditor(null)}
    onUpdated={(entry) => {
      setCollectionEditor(entry);
      setEntries((current) => current.map((item) => item.id === entry.id ? entry : item));
      setRefreshNonce((current) => current + 1);
    }} />;
  if (page) {
    return <><section className="citation-library-page management-page">
      <header className="section-title citation-library-page-header">
        <div><h1><BookMarked aria-hidden size={25} />{t("citationLibrary.title")}</h1><p>{t("citationLibraryHomeDescription")}</p></div>
        {onBack && <button type="button" className="dashboard-back-button" onClick={onBack}><ArrowLeft size={14} />{t("navigation.backToProjects")}</button>}
      </header>
      {libraryBody}{collectionManagement}
      </section>{tagEditor && <Modal open className="management-dialog" title={t("citationLibrary.tagsTitle", { key: tagEditor.citationKey })} description={t("citationLibrary.tags")} onOpenChange={(next) => { if (!next) { setTagEditor(null); setError(""); } }}><>{error && <p className="error dialog-error">{error}</p>}<CitationTagEditor feedback={completedAction.message === `tags:${tagEditor.id}` ? t("editor.saved") : ""} entry={tagEditor} tags={tags} selectedIds={tagEditorIds} saving={tagSaving} modal onClose={() => { setTagEditor(null); setError(""); }} onToggle={(tagId) => setTagEditorIds((current) => current.includes(tagId) ? current.filter((id) => id !== tagId) : [...current, tagId])} onSave={() => void saveTags()} t={t} /></></Modal>}{editing && <Modal open extraWide className="management-dialog" title={t("citationLibrary.editTitle", { key: editing.citationKey })} description={t("citationLibrary.title")} onOpenChange={(next) => { if (!next) { setEditing(null); setError(""); } }}><>{error && <p className="error dialog-error">{error}</p>}<CitationEditPanel feedback={completedAction.message === `edit:${editing.id}` ? t("editor.saved") : ""} title={t("citationLibrary.editTitle", { key: editing.citationKey })} value={editText} saving={savingKey === editing.citationKey} modal onChange={setEditText} onClose={() => { setEditing(null); setError(""); }} onSave={() => void saveEdited()} t={t} /></></Modal>}{deleteConfirmation}{tagManagement}</>;
  }
  return <><Modal open={open} extraWide className="citation-library-modal management-dialog" title={t("citationLibrary.title")} description={t("citationLibraryHomeDescription")} onOpenChange={onOpenChange} footer={<button onClick={() => onOpenChange(false)}>{t("common.close")}</button>}>
    {libraryBody}{collectionManagement}
  </Modal>{deleteConfirmation}{tagManagement}</>;
}

function CitationTagEditor({ entry, tags, selectedIds, saving, feedback, modal = false, onClose, onToggle, onSave, t }: {
  entry: CitationLibraryEntry;
  tags: CitationLibraryTag[];
  selectedIds: string[];
  saving: boolean;
  feedback?: string;
  modal?: boolean;
  onClose: () => void;
  onToggle: (tagId: string) => void;
  onSave: () => void;
  t: TFunction;
}) {
  const body = <>
    <div className="citation-tag-choice-list">{tags.length === 0 ? <span className="muted">{t("citationLibrary.noTagsToAssign")}</span> : tags.map((tag) => <label key={tag.id}><input type="checkbox" disabled={saving} checked={selectedIds.includes(tag.id)} onChange={() => onToggle(tag.id)} /><span className={`citation-tag-dot tag-${tag.color}`} />{tag.name}</label>)}</div>
    <div className="citation-edit-actions"><button type="button" onClick={onClose}>{t("common.cancel")}</button><SaveButton saving={saving} feedback={feedback} disabled={tags.length === 0} onClick={onSave}>{t("citationLibrary.saveTags")}</SaveButton></div>
  </>;
  if (modal) return <div className="citation-modal-form">{body}</div>;
  return <div className="citation-tag-editor"><div className="citation-edit-header"><strong>{t("citationLibrary.tagsTitle", { key: entry.citationKey })}</strong><button type="button" aria-label={t("common.close")} onClick={onClose}><X size={15} /></button></div>{body}</div>;
}

function CitationEditPanel({ title, value, saving, feedback, modal = false, onChange, onClose, onSave, t }: {
  title: string;
  value: string;
  saving: boolean;
  feedback?: string;
  modal?: boolean;
  onChange: (value: string) => void;
  onClose: () => void;
  onSave: () => void;
  t: TFunction;
}) {
  const body = <>
    <textarea autoFocus={!modal} disabled={saving} value={value} onChange={(event) => onChange(event.target.value)} spellCheck={false} rows={12} />
    <div className="citation-edit-actions"><button type="button" onClick={onClose}>{t("common.cancel")}</button><SaveButton saving={saving} feedback={feedback} disabled={!value.trim()} onClick={onSave}>{t("common.save")}</SaveButton></div>
  </>;
  if (modal) return <div className="citation-modal-form citation-edit-panel">{body}</div>;
  return <div className="citation-edit-panel"><div className="citation-edit-header"><strong>{title}</strong><button type="button" aria-label={t("common.close")} onClick={onClose}><X size={15} /></button></div>{body}</div>;
}
