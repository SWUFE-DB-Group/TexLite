import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Import } from "lucide-react";
import { CITATION_FOLDER_FORMAT, CITATION_FOLDER_VERSION, MAX_CITATION_FOLDER_BYTES, MAX_CITATION_FOLDER_ENTRIES,
  MAX_CITATION_NOTES_BYTES, type CitationFolderBundle } from "../shared/citationTransfer";
import { api } from "./api";
import { parseSingleBibEntry } from "./citationLibrary";
import { Modal } from "./Dialog";
import { errorMessage } from "./errors";
import { SaveButton } from "./SaveButton";

export function CitationFolderImportDialog({ maxBibtexBytes, onClose, onImported }: {
  maxBibtexBytes: number;
  onClose: () => void;
  onImported: (id: string) => void;
}) {
  const { t } = useTranslation();
  const [bundle, setBundle] = useState<CitationFolderBundle | null>(null);
  const [reading, setReading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const request = useRef<AbortController | null>(null);
  const pending = useRef(false);
  const selection = useRef(0);
  useEffect(() => {
    const controller = new AbortController(); request.current = controller;
    return () => { controller.abort(); selection.current++; };
  }, []);
  const readFile = async (file: File | undefined) => {
    const sequence = ++selection.current;
    setBundle(null); setError("");
    if (!file) return;
    setReading(true);
    try {
      if (file.size > MAX_CITATION_FOLDER_BYTES) throw new Error(t("citationFolders.transferTooLarge"));
      let data: Partial<CitationFolderBundle> | null;
      try { data = JSON.parse((await file.text()).replace(/^\uFEFF/, "")); }
      catch { throw new Error(t("citationFolders.importInvalid")); }
      if (!data || data.format !== CITATION_FOLDER_FORMAT || data.version !== CITATION_FOLDER_VERSION
        || typeof data.name !== "string" || !data.name.trim() || data.name.trim().length > 80
        || !Array.isArray(data.entries) || data.entries.length > MAX_CITATION_FOLDER_ENTRIES) throw new Error(t("citationFolders.importInvalid"));
      const entries = data.entries.map((entry) => {
        if (!entry || typeof entry.bibtex !== "string" || typeof entry.notes !== "string") throw new Error(t("citationFolders.importInvalid"));
        if (new TextEncoder().encode(entry.notes).byteLength > MAX_CITATION_NOTES_BYTES) throw new Error(t("citationNotes.tooLarge"));
        const parsed = parseSingleBibEntry(entry.bibtex, maxBibtexBytes);
        if (!parsed) throw new Error(t("citationFolders.importInvalid"));
        return { ...parsed, notes: entry.notes };
      });
      if (sequence === selection.current) setBundle({ format: CITATION_FOLDER_FORMAT, version: CITATION_FOLDER_VERSION, name: data.name.trim(), entries });
    } catch (reason) { if (sequence === selection.current) setError(errorMessage(reason)); }
    finally { if (sequence === selection.current) setReading(false); }
  };
  const save = async () => {
    const signal = request.current?.signal;
    if (!bundle || pending.current || reading || !signal || signal.aborted) return;
    pending.current = true; setSaving(true); setError("");
    try {
      const result = await api<{ collection: { id: string } }>("/api/citations/collections/import", { method: "POST", body: JSON.stringify(bundle), signal });
      if (!signal.aborted) { onImported(result.collection.id); onClose(); }
    } catch (reason) { if (!signal.aborted) setError(errorMessage(reason)); }
    finally { pending.current = false; if (!signal.aborted) setSaving(false); }
  };
  return <Modal open className="management-dialog" title={t("citationFolders.import")} description={t("citationFolders.importDescription")}
    onOpenChange={(open) => { if (!open && !saving) onClose(); }} footer={<>
      <button type="button" disabled={saving} onClick={onClose}>{t("common.cancel")}</button>
      <SaveButton icon={<Import size={14} aria-hidden />} saving={saving} disabled={!bundle || reading} onClick={() => void save()}>{t("citationFolders.import")}</SaveButton>
    </>}>
    <div className="citation-folder-import">
      <label>{t("citationFolders.importFile")}<input type="file" accept=".json,application/json" disabled={saving || reading}
        onChange={(event) => void readFile(event.target.files?.[0])} /></label>
      {reading && <p role="status">{t("common.loading")}</p>}
      {bundle && <p role="status">{t("citationFolders.importPreview", { name: bundle.name, count: bundle.entries.length })}</p>}
      {error && <p className="error dialog-error" role="alert">{error}</p>}
    </div>
  </Modal>;
}
