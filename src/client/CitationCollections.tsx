import { useEffect, useRef, useState, type ReactNode } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { BookMarked, Download, Folder, FolderOpen, Import, Inbox, MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { api } from "./api";
import { appPath } from "./basePath";
import { Modal, ConfirmDialog } from "./Dialog";
import { SaveButton } from "./SaveButton";
import { errorMessage } from "./errors";
import { useSuccessNotice } from "./SuccessNotice";
import type { CitationCollectionCatalog } from "../shared/citationCollections";
import type { CitationLibraryEntry } from "./types";
import { CitationFolderImportDialog } from "./CitationFolderImportDialog";

const citationCollectionExportPath = (id: string) => appPath(`/api/citations/collections/${encodeURIComponent(id)}/export`);

export function CitationCollections({ catalog, selected, onSelect, onChanged, onDeleted, manage = true, maxBibtexBytes, onImported }: {
  catalog: CitationCollectionCatalog;
  selected: string;
  onSelect: (id: string) => void;
  onChanged: (selected?: string) => void;
  onDeleted: (id: string) => void;
  manage?: boolean;
  maxBibtexBytes?: number;
  onImported?: (id: string) => void;
}) {
  const { t } = useTranslation();
  const [edit, setEdit] = useState<{ id?: string; name: string } | null>(null);
  const [name, setName] = useState("");
  const [remove, setRemove] = useState<{ id: string; name: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [importing, setImporting] = useState(false);
  const request = useRef<AbortController | null>(null);
  const pending = useRef(false);
  useEffect(() => {
    const controller = new AbortController(); request.current = controller;
    return () => controller.abort();
  }, []);
  const save = async () => {
    const signal = request.current?.signal;
    if (!edit || !name.trim() || pending.current || !signal || signal.aborted) return;
    pending.current = true; setBusy(true); setError("");
    try {
      const result = await api<{ collection?: { id: string } }>(edit.id ? `/api/citations/collections/${encodeURIComponent(edit.id)}` : "/api/citations/collections", {
        method: edit.id ? "PATCH" : "POST", body: JSON.stringify({ name }), signal
      });
      if (!signal.aborted) { onChanged(edit.id ? undefined : result.collection!.id); setEdit(null); }
    } catch (reason) { if (!signal.aborted) setError(errorMessage(reason)); }
    finally { pending.current = false; if (!signal.aborted) setBusy(false); }
  };
  const deleteFolder = async () => {
    const signal = request.current?.signal;
    if (!remove || pending.current || !signal || signal.aborted) return;
    pending.current = true; setBusy(true); setError("");
    try {
      await api(`/api/citations/collections/${encodeURIComponent(remove.id)}`, { method: "DELETE", signal });
      if (!signal.aborted) { onDeleted(remove.id); setRemove(null); }
    } catch (reason) { if (!signal.aborted) setError(errorMessage(reason)); }
    finally { pending.current = false; if (!signal.aborted) setBusy(false); }
  };
  const select = (id: string, title: string, count: number, icon: ReactNode) => <button type="button" className={`citation-collection-select${selected === id ? " active" : ""}`}
    aria-current={selected === id ? "true" : undefined} onClick={() => onSelect(id)}>{icon}<span>{title}</span><small>{count}</small></button>;
  return <aside className="citation-collections">
    <div className="citation-collections-heading"><strong>{t("citationFolders.title")}</strong>{manage && <div className="citation-collections-heading-actions">
      {onImported && maxBibtexBytes && <button type="button" aria-label={t("citationFolders.import")} data-tooltip={t("citationFolders.import")} onClick={() => setImporting(true)}><Import size={15} /></button>}
      <button type="button" aria-label={t("citationFolders.create")} data-tooltip={t("citationFolders.create")}
        onClick={() => { setEdit({ name: "" }); setName(""); setError(""); }}><Plus size={15} /></button></div>}</div>
    <nav aria-label={t("citationFolders.title")}>
      {select("", t("citationFolders.all"), catalog.total, <BookMarked size={15} aria-hidden />)}
      {select("unfiled", t("citationFolders.unfiled"), catalog.unfiled, <Inbox size={15} aria-hidden />)}
      <div className="citation-collection-folders">{catalog.collections.map((folder) => <div className="citation-collection-row" key={folder.id}>
        {select(folder.id, folder.name, folder.entryCount, selected === folder.id ? <FolderOpen size={15} aria-hidden /> : <Folder size={15} aria-hidden />)}
        {manage && <DropdownMenu.Root modal={false}><DropdownMenu.Trigger asChild><button type="button" className="citation-collection-menu-trigger" aria-label={t("citationFolders.actions", { name: folder.name })}><MoreHorizontal size={15} /></button></DropdownMenu.Trigger>
          <DropdownMenu.Portal><DropdownMenu.Content className="citation-entry-menu" sideOffset={4} align="start" collisionPadding={8}>
            <DropdownMenu.Item onSelect={() => { setEdit(folder); setName(folder.name); setError(""); }}><Pencil size={14} />{t("citationFolders.rename")}</DropdownMenu.Item>
            <DropdownMenu.Item asChild><a href={citationCollectionExportPath(folder.id)} download><Download size={14} />{t("citationFolders.export")}</a></DropdownMenu.Item>
            <DropdownMenu.Item asChild><a href={`${citationCollectionExportPath(folder.id)}?notes=true`} download><Download size={14} />{t("citationFolders.exportWithNotes")}</a></DropdownMenu.Item>
            <DropdownMenu.Separator className="citation-entry-menu-separator" />
            <DropdownMenu.Item className="danger-text" onSelect={() => { setRemove(folder); setError(""); }}><Trash2 size={14} />{t("citationFolders.delete")}</DropdownMenu.Item>
          </DropdownMenu.Content></DropdownMenu.Portal>
        </DropdownMenu.Root>}
      </div>)}</div>
    </nav>
    {importing && maxBibtexBytes && onImported && <CitationFolderImportDialog maxBibtexBytes={maxBibtexBytes} onClose={() => setImporting(false)} onImported={onImported} />}
    <Modal open={Boolean(edit)} className="management-dialog" title={t(edit?.id ? "citationFolders.rename" : "citationFolders.create")} onOpenChange={(open) => { if (!open && !busy) setEdit(null); }}
      footer={<><button type="button" disabled={busy} onClick={() => setEdit(null)}>{t("common.cancel")}</button><SaveButton saving={busy} disabled={!name.trim() || Boolean(edit?.id && name.trim() === edit.name)} onClick={() => void save()}>{t(edit?.id ? "common.save" : "common.create")}</SaveButton></>}>
      <form onSubmit={(event) => { event.preventDefault(); void save(); }} className="citation-folder-form">
        <label>{t("citationFolders.name")}<input autoFocus maxLength={80} disabled={busy} value={name} onChange={(event) => setName(event.target.value)} /></label>
        {error && edit && <p className="error dialog-error" role="alert">{error}</p>}
      </form>
    </Modal>
    <ConfirmDialog open={Boolean(remove)} title={t("citationFolders.delete")} description={t("citationFolders.deleteDescription", { name: remove?.name ?? "" })}
      confirmLabel={t("common.delete")} danger busy={busy} error={error} onCancel={() => { if (!busy) setRemove(null); }} onConfirm={() => void deleteFolder()} />
  </aside>;
}

export function CitationCollectionEditor({ entry, catalog, onClose, onUpdated }: {
  entry: CitationLibraryEntry;
  catalog: CitationCollectionCatalog;
  onClose: () => void;
  onUpdated: (entry: CitationLibraryEntry) => void;
}) {
  const { t } = useTranslation();
  const [ids, setIds] = useState(entry.collectionIds);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const feedback = useSuccessNotice();
  const pending = useRef(false);
  const request = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController(); request.current = controller;
    return () => controller.abort();
  }, []);
  const save = async () => {
    const signal = request.current?.signal;
    if (pending.current || !signal || signal.aborted) return;
    pending.current = true; setBusy(true); setError(""); feedback.clear();
    try {
      const result = await api<{ entry: CitationLibraryEntry }>(`/api/citations/${encodeURIComponent(entry.id)}/collections`, {
        method: "PATCH", body: JSON.stringify({ collectionIds: ids, expectedRevision: entry.revision }), signal
      });
      if (!signal.aborted) { onUpdated(result.entry); feedback.show("saved"); }
    } catch (reason) { if (!signal.aborted) setError(errorMessage(reason)); }
    finally { pending.current = false; if (!signal.aborted) setBusy(false); }
  };
  const unchanged = ids.length === entry.collectionIds.length && ids.every((id) => entry.collectionIds.includes(id));
  return <Modal open className="management-dialog" title={t("citationFolders.assignTitle", { key: entry.citationKey })} onOpenChange={(open) => { if (!open && !busy) onClose(); }}
    footer={<><button disabled={busy} onClick={onClose}>{t("common.cancel")}</button><SaveButton saving={busy} disabled={unchanged} feedback={feedback.message ? t("editor.saved") : ""} onClick={() => void save()}>{t("common.save")}</SaveButton></>}>
    {error && <p className="error dialog-error" role="alert">{error}</p>}
    <div className="citation-collection-choices">{catalog.collections.length === 0 ? <p className="muted">{t("citationFolders.none")}</p> : catalog.collections.map((folder) => <label key={folder.id}>
      <input type="checkbox" disabled={busy} checked={ids.includes(folder.id)} onChange={() => { feedback.clear(); setIds((current) => current.includes(folder.id) ? current.filter((id) => id !== folder.id) : [...current, folder.id]); }} />
      <Folder size={15} aria-hidden /><span>{folder.name}</span>
    </label>)}</div>
  </Modal>;
}
