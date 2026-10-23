import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { LoaderCircle, RotateCcw, Search } from "lucide-react";
import { api } from "./api";
import { Modal } from "./Dialog";
import { errorMessage } from "./errors";
import { FileTypeIcon } from "./fileIcons";
import type { HistoryTrackedFile } from "../shared/historyTracking";

export function HistoryFilesManager({ open, projectId, onOpenChange, onSaved }: {
  open: boolean;
  projectId: string;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const [files, setFiles] = useState<HistoryTrackedFile[]>([]);
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState("");
  const lifecycle = useRef<AbortController | null>(null);
  const pending = useRef(false);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    lifecycle.current = controller;
    setFiles([]); setQuery(""); setError(""); setLoading(true); setSaving(""); pending.current = false;
    void api<{ files: HistoryTrackedFile[] }>(`/api/projects/${projectId}/history/files`, { signal: controller.signal })
      .then((result) => { if (!controller.signal.aborted) setFiles(result.files); })
      .catch((reason) => { if (!controller.signal.aborted) setError(errorMessage(reason)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => { controller.abort(); if (lifecycle.current === controller) lifecycle.current = null; };
  }, [open, projectId]);

  const save = async (path: string, included: boolean | null) => {
    const controller = lifecycle.current;
    if (!controller || controller.signal.aborted || loading || pending.current) return;
    pending.current = true; setSaving(path); setError("");
    try {
      const result = await api<{ files: HistoryTrackedFile[] }>(`/api/projects/${projectId}/history/files`, {
        method: "PATCH", body: JSON.stringify({ path, included }), signal: controller.signal
      });
      if (controller.signal.aborted) return;
      setFiles(result.files);
      onSaved();
    } catch (reason) {
      if (!controller.signal.aborted) setError(errorMessage(reason));
    } finally {
      if (!controller.signal.aborted) { pending.current = false; setSaving(""); }
    }
  };

  const visible = useMemo(() => files.filter((file) => file.path.toLowerCase().includes(query.trim().toLowerCase())), [files, query]);
  return <Modal open={open} wide className="history-tracking-modal" title={t("history.manageFiles")} description={t("history.trackingDescription")}
    onOpenChange={onOpenChange} footer={<button type="button" onClick={() => onOpenChange(false)}>{t("common.close")}</button>}>
    <div className="history-tracking">
      <p className="muted">{t("history.trackingHint")}</p>
      <label className="history-tracking-search"><Search size={15} aria-hidden /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("history.searchFiles")} aria-label={t("history.searchFiles")} /></label>
      {error && <p className="error" role="alert">{error}</p>}
      {loading ? <p className="muted"><LoaderCircle className="spin" size={15} />{t("common.loading")}</p>
        : <div className="history-tracking-grid" aria-busy={Boolean(saving)}>
          {visible.map((file) => {
            const slash = file.path.lastIndexOf("/");
            const name = file.path.slice(slash + 1);
            const directory = slash < 0 ? "./" : file.path.slice(0, slash + 1);
            return <div className={`history-tracking-card${file.included ? " included" : ""}${file.missing ? " missing" : ""}`} key={file.path}>
              <label>
                <FileTypeIcon path={file.path} size={21} />
                <span className="history-tracking-path"><strong title={file.path}>{name}</strong><small title={directory}>{directory}</small></span>
                <input type="checkbox" checked={file.included} disabled={Boolean(saving) || file.missing} onChange={(event) => void save(file.path, event.target.checked)} />
              </label>
              <div className="history-tracking-card-footer">
                <small>{file.missing ? t("history.fileMissing") : file.override !== null ? t("history.customTracking") : file.defaultIncluded ? t("history.defaultTracked") : t("history.defaultUntracked")}</small>
                {saving === file.path ? <LoaderCircle className="spin" size={14} aria-label={t("common.loading")} />
                  : file.override !== null && <button type="button" disabled={Boolean(saving)} onClick={() => void save(file.path, null)} title={t("history.resetTracking")} aria-label={t("history.resetTracking")}><RotateCcw size={14} /></button>}
              </div>
            </div>;
          })}
          {visible.length === 0 && <p className="muted">{t("history.noMatchingFiles")}</p>}
        </div>}
    </div>
  </Modal>;
}
