import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Import, LibraryBig, Upload, X } from "lucide-react";
import { MAX_CITATION_FOLDER_BYTES, type CitationFolderBundle, type CitationFolderImportRequest } from "../shared/citationTransfer";
import { api } from "./api";
import { CitationFolderImportError, parseCitationFolderFile } from "./citationFolderImport";
import { Modal } from "./Dialog";
import { errorMessage } from "./errors";
import { formatBytes } from "./formatBytes";
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
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const request = useRef<AbortController | null>(null);
  const pending = useRef(false);
  const selection = useRef(0);
  useEffect(() => {
    const controller = new AbortController(); request.current = controller;
    return () => { controller.abort(); selection.current++; };
  }, []);
  const readFile = async (file: File | undefined) => {
    if (pending.current) return;
    const sequence = ++selection.current;
    setBundle(null); setError(""); setFile(file ?? null); setReading(Boolean(file));
    setName(file ? file.name.replace(/\.(?:bib|json)$/i, "").trim().slice(0, 80) : "");
    if (!file) return;
    try {
      if (file.size > MAX_CITATION_FOLDER_BYTES) throw new Error(t("citationFolders.transferTooLarge"));
      const bundle = parseCitationFolderFile(await file.text(), file.name, maxBibtexBytes);
      if (sequence === selection.current) setBundle(bundle);
    } catch (reason) { if (sequence === selection.current) setError(reason instanceof CitationFolderImportError ? t(reason.key) : errorMessage(reason)); }
    finally { if (sequence === selection.current) setReading(false); }
  };
  const save = async () => {
    const signal = request.current?.signal;
    if (!bundle || !name.trim() || name.trim().length > 80 || pending.current || reading || !signal || signal.aborted) return;
    pending.current = true; setSaving(true); setError("");
    try {
      const payload: CitationFolderImportRequest = { ...bundle, name: name.trim() };
      const body = JSON.stringify(payload);
      if (new TextEncoder().encode(body).byteLength > MAX_CITATION_FOLDER_BYTES) throw new Error(t("citationFolders.transferTooLarge"));
      const result = await api<{ collection: { id: string } }>("/api/citations/collections/import", { method: "POST", body, signal });
      if (!signal.aborted) { onImported(result.collection.id); onClose(); }
    } catch (reason) { if (!signal.aborted) setError(errorMessage(reason)); }
    finally { pending.current = false; if (!signal.aborted) setSaving(false); }
  };
  return <Modal open className="management-dialog" title={t("citationFolders.import")} description={t("citationFolders.importDescription")}
    onOpenChange={(open) => { if (!open && !saving) onClose(); }} footer={<>
      <button type="button" disabled={saving} onClick={onClose}>{t("common.cancel")}</button>
      <SaveButton icon={<Import size={14} aria-hidden />} saving={saving} disabled={!bundle || reading || !name.trim() || name.trim().length > 80} onClick={() => void save()}>{t("citationFolders.import")}</SaveButton>
    </>}>
    <div className="citation-folder-import">
      <div className={`upload-picker${file ? " has-file" : ""}${saving || reading ? " is-disabled" : ""}`}
        onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = saving || reading ? "none" : "copy"; }}
        onDrop={(event) => {
          event.preventDefault();
          if (saving || reading) return;
          if (event.dataTransfer.files.length !== 1) {
            void readFile(undefined); setError(t("citationFolders.importSingleFile"));
          } else void readFile(event.dataTransfer.files[0]);
        }}>
        <input ref={input} className="sr-only" type="file" aria-label={t("citationFolders.importFile")}
          accept=".bib,.json,application/json,application/x-bibtex,text/x-bibtex" disabled={saving || reading}
          onChange={(event) => { const selected = event.target.files?.[0]; event.target.value = ""; if (selected) void readFile(selected); }} />
        <LibraryBig size={34} aria-hidden />
        <div className="upload-picker-copy"><strong>{file?.name ?? t("citationFolders.importFile")}</strong>
          <span>{file ? formatBytes(file.size, { maximumUnit: "MB" }) : t("citationFolders.importDrop")}</span></div>
        <button type="button" disabled={saving || reading} onClick={() => input.current?.click()}><Upload size={15} aria-hidden />{t("projects.browse")}</button>
        {file && <button className="upload-clear" type="button" disabled={saving || reading} aria-label={t("projects.clearFile")}
          data-tooltip={t("projects.clearFile")} onClick={() => void readFile(undefined)}><X size={14} aria-hidden /></button>}
      </div>
      {file && <label className="form-field">{t("citationFolders.name")}<input type="text" maxLength={80} disabled={saving}
        value={name} onChange={(event) => setName(event.target.value)} /></label>}
      {reading && <p role="status">{t("common.loading")}</p>}
      {bundle && <p role="status">{t("citationFolders.importPreview", { name: name.trim(), count: bundle.entries.length })}</p>}
      {error && <p className="error dialog-error" role="alert">{error}</p>}
    </div>
  </Modal>;
}
