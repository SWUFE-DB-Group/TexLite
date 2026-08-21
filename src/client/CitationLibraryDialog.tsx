import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { BookMarked, Check, ChevronLeft, ChevronRight, Edit3, Import, LoaderCircle, Plus, Search, Tags, Trash2, X } from "lucide-react";
import { Modal } from "./Dialog";
import { api } from "./api";
import { errorMessage } from "./errors";
import { parseBibEntries, parseSingleBibEntry, type ParsedCitationEntry } from "./citationLibrary";
import type { CitationLibraryEntry, CitationLibraryTag, ProjectListPagination, TagColor } from "./types";

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
  onInsert?: (entry: CitationLibraryEntry) => boolean | Promise<boolean>;
}

type View = "library" | "current";
type CitationLookupMatch = Pick<CitationLibraryEntry, "id" | "citationKey" | "revision">;
const EMPTY_CITATION_ENTRIES: ParsedCitationEntry[] = [];

export function CitationLibraryDialog({ open, onOpenChange, page = false, onBack, currentFile = "", currentSource = "", readOnly = false, currentUserId, onInsert }: Props) {
  const { t } = useTranslation();
  const [view, setView] = useState<View>("library");
  const [query, setQuery] = useState("");
  const [selectedTag, setSelectedTag] = useState("");
  const [entries, setEntries] = useState<CitationLibraryEntry[]>([]);
  const [pageNumber, setPageNumber] = useState(1);
  const [pagination, setPagination] = useState<ProjectListPagination>({ page: 1, pageSize: 60, total: 0, totalPages: 0 });
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [tags, setTags] = useState<CitationLibraryTag[]>([]);
  const [newTagName, setNewTagName] = useState("");
  const [newTagColor, setNewTagColor] = useState<TagColor>("green");
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
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [savedEntries, setSavedEntries] = useState<Map<string, CitationLookupMatch>>(new Map());
  const [lookupLoading, setLookupLoading] = useState(false);
  const [lookupNonce, setLookupNonce] = useState(0);
  const hasCurrentFile = Boolean(/\.bib$/i.test(currentFile) && onInsert);
  const currentEntries = useMemo(() => open && hasCurrentFile ? parseBibEntries(currentSource) : EMPTY_CITATION_ENTRIES, [open, currentSource, hasCurrentFile]);
  const currentCitationKeys = useMemo(() => new Set(currentEntries.map((entry) => entry.citationKey.toLowerCase())), [currentEntries]);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setLoading(true);
      setError("");
      const params = new URLSearchParams();
      if (query.trim()) params.set("q", query.trim());
      if (selectedTag) params.set("tag", selectedTag);
      params.set("page", String(pageNumber));
      params.set("pageSize", "60");
      void api<{ entries: CitationLibraryEntry[]; pagination: ProjectListPagination }>(`/api/citations?${params.toString()}`, { signal: controller.signal })
        .then((result) => { setEntries(result.entries); setPagination(result.pagination); if (result.pagination.page !== pageNumber) setPageNumber(result.pagination.page); })
        .catch((requestError) => {
          if (requestError instanceof Error && requestError.name === "AbortError") return;
          setError(errorMessage(requestError));
        })
        .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    }, query.trim() ? 180 : 0);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [open, query, selectedTag, pageNumber, refreshNonce]);

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
    if (!open || !hasCurrentFile) {
      setSavedEntries(new Map());
      setLookupLoading(false);
      return;
    }
    const controller = new AbortController();
    const keys = [...new Set(currentEntries.map((entry) => entry.citationKey))];
    if (!keys.length) {
      setSavedEntries(new Map());
      setLookupLoading(false);
      return () => controller.abort();
    }
    setLookupLoading(true);
    void api<{ matches: CitationLookupMatch[] }>("/api/citations/lookup", {
      method: "POST", body: JSON.stringify({ keys }), signal: controller.signal
    }).then((result) => {
      setSavedEntries(new Map(result.matches.map((match) => [match.citationKey.toLowerCase(), match])));
    }).catch((requestError) => {
      if (!(requestError instanceof Error && requestError.name === "AbortError")) setError(errorMessage(requestError));
    }).finally(() => { if (!controller.signal.aborted) setLookupLoading(false); });
    return () => controller.abort();
  }, [open, hasCurrentFile, currentEntries, lookupNonce]);

  useEffect(() => {
    if (!open) return;
    setView("library");
    setQuery("");
    setSelectedTag("");
    setPageNumber(1);
    setPagination({ page: 1, pageSize: 60, total: 0, totalPages: 0 });
    setEditing(null);
    setAdding(false);
    setAddText("");
    setTagEditor(null);
    setDeletingId(null);
    setError("");
    setNotice("");
    setSavedEntries(new Map());
  }, [open, hasCurrentFile]);

  const saveEntry = async (entry: ParsedCitationEntry) => {
    setSavingKey(entry.citationKey);
    setError("");
    try {
      const existing = savedEntries.get(entry.citationKey.toLowerCase());
      const result = await api<{ entry: CitationLibraryEntry; updated: boolean }>("/api/citations", {
        method: "POST", body: JSON.stringify({
          bibtex: entry.bibtex, citationKey: entry.citationKey, entryType: entry.entryType,
          title: entry.title, authors: entry.authors, year: entry.year,
          overwrite: Boolean(existing),
          expectedRevision: existing?.revision
        })
      });
      setEntries((current) => [result.entry, ...current.filter((item) => item.id !== result.entry.id && item.citationKey.toLowerCase() !== result.entry.citationKey.toLowerCase())]);
      setSavedEntries((current) => new Map(current).set(result.entry.citationKey.toLowerCase(), {
        id: result.entry.id, citationKey: result.entry.citationKey, revision: result.entry.revision
      }));
      setTagEditor(result.entry);
      setTagEditorIds(result.entry.tags.map((tag) => tag.id));
      setNotice(result.updated ? t("citationLibrary.updated") : t("citationLibrary.saved"));
      setPageNumber(1);
      setRefreshNonce((current) => current + 1);
    } catch (requestError) { setError(errorMessage(requestError)); setLookupNonce((current) => current + 1); }
    finally { setSavingKey(null); }
  };

  const saveEdited = async () => {
    if (!editing) return;
    setSavingKey(editing.citationKey);
    setError("");
    try {
      const parsed = parseSingleBibEntry(editText);
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
      setSavedEntries((current) => {
        const next = new Map(current);
        next.delete(editing.citationKey.toLowerCase());
        next.set(result.entry.citationKey.toLowerCase(), {
          id: result.entry.id, citationKey: result.entry.citationKey, revision: result.entry.revision
        });
        return next;
      });
      setEditing(null);
      setNotice(t("citationLibrary.updated"));
      setPageNumber(1);
      setRefreshNonce((current) => current + 1);
    } catch (requestError) { setError(errorMessage(requestError)); }
    finally { setSavingKey(null); }
  };

  const saveNew = async () => {
    if (!addText.trim()) return;
    setSavingKey("__new__");
    setError("");
    try {
      const parsed = parseSingleBibEntry(addText);
      if (!parsed) {
        setError(t("citationErrors.invalid"));
        return;
      }
      const result = await api<{ entry: CitationLibraryEntry; updated: boolean }>("/api/citations", {
        method: "POST", body: JSON.stringify({
          bibtex: parsed.bibtex, citationKey: parsed.citationKey, entryType: parsed.entryType,
          title: parsed.title, authors: parsed.authors, year: parsed.year
        })
      });
      setEntries((current) => [result.entry, ...current.filter((item) => item.id !== result.entry.id && item.citationKey.toLowerCase() !== result.entry.citationKey.toLowerCase())]);
      setSavedEntries((current) => new Map(current).set(result.entry.citationKey.toLowerCase(), {
        id: result.entry.id, citationKey: result.entry.citationKey, revision: result.entry.revision
      }));
      setAdding(false);
      setAddText("");
      setNotice(result.updated ? t("citationLibrary.updated") : t("citationLibraryActions.added"));
      setTagEditor(result.entry);
      setTagEditorIds(result.entry.tags.map((tag) => tag.id));
      setPageNumber(1);
      setRefreshNonce((current) => current + 1);
    } catch (requestError) { setError(errorMessage(requestError)); }
    finally { setSavingKey(null); }
  };

  const createTag = async () => {
    if (!newTagName.trim()) return;
    setError("");
    try {
      const result = await api<{ tag: CitationLibraryTag }>("/api/citations/tags", {
        method: "POST", body: JSON.stringify({ name: newTagName.trim(), color: newTagColor })
      });
      setTags((current) => [...current.filter((tag) => tag.id !== result.tag.id), result.tag].sort((left, right) => left.name.localeCompare(right.name)));
      setNewTagName("");
      setNotice(t("citationLibrary.tagCreated"));
    } catch (requestError) { setError(errorMessage(requestError)); }
  };

  const editTags = (entry: CitationLibraryEntry) => {
    setEditing(null);
    setAdding(false);
    setTagEditor(entry);
    setTagEditorIds(entry.tags.map((tag) => tag.id));
  };

  const saveTags = async () => {
    if (!tagEditor) return;
    setTagSaving(true);
    setError("");
    try {
      const result = await api<{ entry: CitationLibraryEntry }>(`/api/citations/${encodeURIComponent(tagEditor.id)}/tags`, {
        method: "PATCH", body: JSON.stringify({ tagIds: tagEditorIds, expectedRevision: tagEditor.revision })
      });
      setEntries((current) => current.map((entry) => entry.id === result.entry.id ? result.entry : entry));
      setSavedEntries((current) => new Map(current).set(result.entry.citationKey.toLowerCase(), {
        id: result.entry.id, citationKey: result.entry.citationKey, revision: result.entry.revision
      }));
      setTagEditor(result.entry);
      setTagEditorIds(result.entry.tags.map((tag) => tag.id));
      setNotice(t("citationLibrary.tagsUpdated"));
      setRefreshNonce((current) => current + 1);
    } catch (requestError) { setError(errorMessage(requestError)); }
    finally { setTagSaving(false); }
  };

  const deleteEntry = async (entry: CitationLibraryEntry) => {
    setDeletingId(entry.id);
    setError("");
    try {
      await api(`/api/citations/${encodeURIComponent(entry.id)}`, { method: "DELETE" });
      setEntries((current) => current.filter((item) => item.id !== entry.id));
      setSavedEntries((current) => {
        const next = new Map(current);
        next.delete(entry.citationKey.toLowerCase());
        return next;
      });
      if (editing?.id === entry.id) setEditing(null);
      if (tagEditor?.id === entry.id) setTagEditor(null);
      setNotice(t("citationLibrary.deleted"));
      setPageNumber(1);
      setRefreshNonce((current) => current + 1);
    } catch (requestError) { setError(errorMessage(requestError)); }
    finally { setDeletingId(null); }
  };

  const libraryBody = <div className="citation-library-dialog">
      <div className="citation-library-tabs" role="tablist" aria-label={t("citationLibrary.title")}>
        <button type="button" role="tab" aria-selected={view === "library"} className={view === "library" ? "active" : ""} onClick={() => setView("library")}><BookMarked size={15} />{t("citationLibrary.myLibrary")}<span>{pagination.total}</span></button>
        {hasCurrentFile && <button type="button" role="tab" aria-selected={view === "current"} className={view === "current" ? "active" : ""} onClick={() => setView("current")}><Plus size={15} />{t("citationLibrary.currentFile")}<span>{currentEntries.length}</span></button>}
      </div>
      {error && !(page && (tagEditor || editing)) && <p className="error dialog-error">{error}</p>}
      {notice && <p className="citation-library-notice" role="status"><Check size={14} />{notice}<button type="button" aria-label={t("common.close")} onClick={() => setNotice("")}><X size={13} /></button></p>}
      {view === "library" ? <>
        <div className="citation-library-search-row"><label className="citation-library-search"><Search size={15} /><input autoFocus placeholder={t("citationLibrary.searchPlaceholder")} value={query} onChange={(event) => { setQuery(event.target.value); setPageNumber(1); }} /><span>{t("citationLibrary.searchHint")}</span></label><button type="button" className="citation-add-entry-button" onClick={() => { setAdding(true); setEditing(null); setTagEditor(null); }}><Plus size={14} />{t("citationLibraryActions.addEntry")}</button></div>
        <div className="citation-tag-bar"><div className="citation-tag-filters"><button type="button" className={!selectedTag ? "active" : ""} onClick={() => { setSelectedTag(""); setPageNumber(1); }}>{t("citationLibrary.allTags")}</button>{tags.map((tag) => <button type="button" key={tag.id} className={selectedTag === tag.id ? "active" : ""} onClick={() => { setSelectedTag(selectedTag === tag.id ? "" : tag.id); setPageNumber(1); }}><span className={`citation-tag-dot tag-${tag.color}`} />{tag.name}</button>)}{tags.length === 0 && <span className="muted">{t("citationLibrary.noTags")}</span>}</div><div className="citation-tag-create"><input value={newTagName} placeholder={t("citationLibrary.newTagPlaceholder")} onChange={(event) => setNewTagName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void createTag(); } }} /><select aria-label={t("citationLibrary.tagColor")} value={newTagColor} onChange={(event) => setNewTagColor(event.target.value as TagColor)}>{(["red", "orange", "yellow", "green", "blue", "purple", "gray"] as TagColor[]).map((color) => <option value={color} key={color}>{t(`tags.${color}`)}</option>)}</select><button type="button" disabled={!newTagName.trim()} title={t("citationLibrary.createTag")} onClick={() => void createTag()}><Plus size={13} />{t("citationLibrary.createTag")}</button></div></div>
        {adding && <div className="citation-edit-panel"><div className="citation-edit-header"><div><strong>{t("citationLibraryActions.addEntryTitle")}</strong><small>{t("citationLibraryActions.addEntryDescription")}</small></div><button type="button" aria-label={t("common.close")} onClick={() => setAdding(false)}><X size={15} /></button></div><textarea autoFocus value={addText} onChange={(event) => setAddText(event.target.value)} placeholder={t("citationLibraryActions.addEntryPlaceholder")} spellCheck={false} rows={9} /><div className="citation-edit-actions"><button type="button" onClick={() => setAdding(false)}>{t("common.cancel")}</button><button type="button" className="primary" disabled={!addText.trim() || savingKey === "__new__"} onClick={() => void saveNew()}>{savingKey === "__new__" ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />}{t("citationLibraryActions.addEntry")}</button></div></div>}
        {loading ? <div className="citation-library-empty"><LoaderCircle className="spin" size={22} /><span>{t("common.loading")}</span></div> : entries.length === 0 ? <div className="citation-library-empty"><BookMarked size={28} /><strong>{t("citationLibrary.emptyTitle")}</strong><span>{selectedTag ? t("citationLibrary.noTagMatches") : t("citationLibrary.emptyDescription")}</span></div> : <div className="citation-entry-list">{entries.map((entry) => <div className="citation-entry-item" key={entry.id}><CitationCard entry={entry} currentUserId={currentUserId} selected={tagEditor?.id === entry.id || editing?.id === entry.id} alreadyInFile={!page && currentCitationKeys.has(entry.citationKey.toLowerCase())} importDisabled={readOnly} deleting={deletingId === entry.id} onImport={onInsert ? async () => { if (await onInsert(entry)) onOpenChange(false); } : undefined} onEdit={entry.ownerId === currentUserId ? () => { setTagEditor(null); setAdding(false); setEditing(entry); setEditText(entry.bibtex); } : undefined} onTags={entry.ownerId === currentUserId ? () => editTags(entry) : undefined} onDelete={entry.ownerId === currentUserId ? () => void deleteEntry(entry) : undefined} t={t} />{!page && tagEditor?.id === entry.id && <CitationTagEditor entry={tagEditor} tags={tags} selectedIds={tagEditorIds} saving={tagSaving} onClose={() => setTagEditor(null)} onToggle={(tagId) => setTagEditorIds((current) => current.includes(tagId) ? current.filter((id) => id !== tagId) : [...current, tagId])} onSave={() => void saveTags()} t={t} />}{!page && editing?.id === entry.id && <CitationEditPanel title={t("citationLibrary.editTitle", { key: editing.citationKey })} value={editText} saving={savingKey === editing.citationKey} onChange={setEditText} onClose={() => setEditing(null)} onSave={() => void saveEdited()} t={t} />}</div>)}</div>}
        {pagination.totalPages > 1 && <nav className="citation-library-pagination" aria-label={t("citationLibraryPagination.pageOf", { page: pagination.page, totalPages: pagination.totalPages, count: pagination.total })}><button type="button" disabled={pagination.page <= 1} onClick={() => setPageNumber((current) => Math.max(1, current - 1))}><ChevronLeft size={14} />{t("citationLibraryPagination.previous")}</button><span>{t("citationLibraryPagination.pageOf", { page: pagination.page, totalPages: pagination.totalPages, count: pagination.total })}</span><button type="button" disabled={pagination.page >= pagination.totalPages} onClick={() => setPageNumber((current) => Math.min(pagination.totalPages, current + 1))}>{t("citationLibraryPagination.next")}<ChevronRight size={14} /></button></nav>}
      </> : <>
        <div className="citation-current-heading"><div><strong>{t("citationLibrary.currentFileTitle")}</strong><span>{t("citationLibrary.currentFileDescription")}</span></div><button type="button" onClick={() => setView("library")}><ChevronLeft size={14} />{t("citationLibrary.backToLibrary")}</button></div>
        {currentEntries.length === 0 ? <div className="citation-library-empty"><BookMarked size={28} /><strong>{t("citationLibrary.noEntries")}</strong><span>{t("citationLibrary.noEntriesDescription")}</span></div> : <div className="citation-entry-list">{currentEntries.map((entry, index) => <div className="citation-entry-item" key={`${entry.citationKey}-${index}`}><CitationCard entry={entry} saved={savedEntries.has(entry.citationKey.toLowerCase())} saving={savingKey === entry.citationKey} saveDisabled={lookupLoading} onSave={() => void saveEntry(entry)} t={t} />{!page && tagEditor?.citationKey.toLowerCase() === entry.citationKey.toLowerCase() && <CitationTagEditor entry={tagEditor} tags={tags} selectedIds={tagEditorIds} saving={tagSaving} onClose={() => setTagEditor(null)} onToggle={(tagId) => setTagEditorIds((current) => current.includes(tagId) ? current.filter((id) => id !== tagId) : [...current, tagId])} onSave={() => void saveTags()} t={t} />}</div>)}</div>}
      </>}
    </div>;
  if (page) {
    return <><section className="citation-library-page">
      <header className="citation-library-page-header">
        <div><h1><BookMarked aria-hidden size={26} />{t("citationLibrary.title")}</h1><p>{t("citationLibraryHomeDescription")}</p></div>
        {onBack && <button type="button" onClick={onBack}><ChevronLeft size={15} />{t("projects.title")}</button>}
      </header>
      {libraryBody}
    </section>{tagEditor && <Modal open title={t("citationLibrary.tagsTitle", { key: tagEditor.citationKey })} description={t("citationLibrary.tags")} onOpenChange={(next) => { if (!next) { setTagEditor(null); setError(""); } }}><>{error && <p className="error dialog-error">{error}</p>}<CitationTagEditor entry={tagEditor} tags={tags} selectedIds={tagEditorIds} saving={tagSaving} modal onClose={() => { setTagEditor(null); setError(""); }} onToggle={(tagId) => setTagEditorIds((current) => current.includes(tagId) ? current.filter((id) => id !== tagId) : [...current, tagId])} onSave={() => void saveTags()} t={t} /></></Modal>}{editing && <Modal open extraWide title={t("citationLibrary.editTitle", { key: editing.citationKey })} description={t("citationLibrary.title")} onOpenChange={(next) => { if (!next) { setEditing(null); setError(""); } }}><>{error && <p className="error dialog-error">{error}</p>}<CitationEditPanel title={t("citationLibrary.editTitle", { key: editing.citationKey })} value={editText} saving={savingKey === editing.citationKey} modal onChange={setEditText} onClose={() => { setEditing(null); setError(""); }} onSave={() => void saveEdited()} t={t} /></></Modal>}</>;
  }
  return <Modal open={open} extraWide className="citation-library-modal" title={t("citationLibrary.title")} description={t(hasCurrentFile ? "citationLibrary.description" : "citationLibraryHomeDescription", { file: currentFile })} onOpenChange={onOpenChange} footer={<button onClick={() => onOpenChange(false)}>{t("common.close")}</button>}>
    {libraryBody}
  </Modal>;
}

function CitationCard({ entry, currentUserId, selected, alreadyInFile, saved, saving, saveDisabled, importDisabled, deleting, onSave, onImport, onEdit, onTags, onDelete, t }: {
  entry: ParsedCitationEntry | CitationLibraryEntry;
  currentUserId?: string;
  selected?: boolean;
  alreadyInFile?: boolean;
  saved?: boolean;
  saving?: boolean;
  saveDisabled?: boolean;
  importDisabled?: boolean;
  deleting?: boolean;
  onSave?: () => void;
  onImport?: () => void | Promise<void>;
  onEdit?: () => void;
  onTags?: () => void;
  onDelete?: () => void;
  t: TFunction;
}) {
  const isLibraryEntry = "id" in entry;
  const libraryEntry = isLibraryEntry ? entry as CitationLibraryEntry : null;
  return <article className={`citation-entry-card${selected ? " selected" : ""}${alreadyInFile ? " already-in-file" : ""}`} title={alreadyInFile ? t("citationErrors.alreadyInFile", { key: entry.citationKey }) : undefined}><div className="citation-entry-main"><div className="citation-entry-heading"><code>{entry.citationKey}</code><span>@{entry.entryType}</span>{saved && <em><Check size={11} />{t("citationLibrary.savedLabel")}</em>}</div><strong>{entry.title || t("citationLibrary.untitled")}</strong><p>{entry.authors || t("citationLibrary.authorUnknown")}{entry.year && <span> · {entry.year}</span>}</p>{libraryEntry && libraryEntry.tags.length > 0 && <div className="citation-entry-tags">{libraryEntry.tags.map((tag) => <span className={`citation-tag-pill tag-${tag.color}`} key={tag.id}><span className="citation-tag-dot" />{tag.name}</span>)}</div>}</div><div className="citation-entry-actions">{onSave && <button type="button" className={saved ? "saved" : "primary"} disabled={saving || saveDisabled} onClick={onSave}>{saving || saveDisabled ? <LoaderCircle className="spin" size={13} /> : saved ? <Check size={13} /> : <Plus size={13} />}{saving ? t("citationLibrary.saving") : saved ? t("citationLibrary.update") : t("citationLibrary.save")}</button>}{onImport && <button type="button" disabled={importDisabled || alreadyInFile} title={alreadyInFile ? t("citationErrors.alreadyInFile", { key: entry.citationKey }) : importDisabled ? t("citationLibrary.importRequiresWrite") : t("citationLibrary.importToFile")} onClick={() => void onImport()}><Import size={13} />{t("citationLibrary.import")}</button>}{libraryEntry && onTags && <button type="button" onClick={onTags}><Tags size={13} />{t("citationLibrary.tags")}</button>}{isLibraryEntry && onEdit && <button type="button" onClick={onEdit}><Edit3 size={13} />{t("common.edit")}</button>}{isLibraryEntry && onDelete && <button type="button" className="danger-text" disabled={deleting} onClick={onDelete}>{deleting ? <LoaderCircle className="spin" size={13} /> : <Trash2 size={13} />}{t("common.delete")}</button>}</div></article>;
}

function CitationTagEditor({ entry, tags, selectedIds, saving, modal = false, onClose, onToggle, onSave, t }: {
  entry: CitationLibraryEntry;
  tags: CitationLibraryTag[];
  selectedIds: string[];
  saving: boolean;
  modal?: boolean;
  onClose: () => void;
  onToggle: (tagId: string) => void;
  onSave: () => void;
  t: TFunction;
}) {
  const body = <>
    <div className="citation-tag-choice-list">{tags.length === 0 ? <span className="muted">{t("citationLibrary.noTagsToAssign")}</span> : tags.map((tag) => <label key={tag.id}><input type="checkbox" checked={selectedIds.includes(tag.id)} onChange={() => onToggle(tag.id)} /><span className={`citation-tag-dot tag-${tag.color}`} />{tag.name}</label>)}</div>
    <div className="citation-edit-actions"><button type="button" onClick={onClose}>{t("common.cancel")}</button><button type="button" className="primary" disabled={saving || tags.length === 0} onClick={onSave}>{saving ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />}{t("citationLibrary.saveTags")}</button></div>
  </>;
  if (modal) return <div className="citation-modal-form">{body}</div>;
  return <div className="citation-tag-editor"><div className="citation-edit-header"><strong>{t("citationLibrary.tagsTitle", { key: entry.citationKey })}</strong><button type="button" aria-label={t("common.close")} onClick={onClose}><X size={15} /></button></div>{body}</div>;
}

function CitationEditPanel({ title, value, saving, modal = false, onChange, onClose, onSave, t }: {
  title: string;
  value: string;
  saving: boolean;
  modal?: boolean;
  onChange: (value: string) => void;
  onClose: () => void;
  onSave: () => void;
  t: TFunction;
}) {
  const body = <>
    <textarea autoFocus={!modal} value={value} onChange={(event) => onChange(event.target.value)} spellCheck={false} rows={12} />
    <div className="citation-edit-actions"><button type="button" onClick={onClose}>{t("common.cancel")}</button><button type="button" className="primary" disabled={!value.trim() || saving} onClick={onSave}>{saving ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />}{t("common.save")}</button></div>
  </>;
  if (modal) return <div className="citation-modal-form citation-edit-panel">{body}</div>;
  return <div className="citation-edit-panel"><div className="citation-edit-header"><strong>{title}</strong><button type="button" aria-label={t("common.close")} onClick={onClose}><X size={15} /></button></div>{body}</div>;
}
