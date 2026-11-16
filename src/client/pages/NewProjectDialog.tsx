import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { FileArchive, FileText, Link, LoaderCircle } from "lucide-react";
import { Trans, useTranslation } from "react-i18next";
import { api, isAbortError } from "../api";
import { Modal } from "../Dialog";
import { InfoPopover } from "../InfoPopover";
import { ProjectImportActivity } from "./ProjectImportActivity";
import { errorMessage } from "../errors";
import type { Project } from "../types";

export function NewProjectDialog({ open, maxUploadSizeMB, onOpenChange, onCreated }: {
  open: boolean;
  maxUploadSizeMB: number;
  onOpenChange: (open: boolean) => void;
  onCreated: (projectId: string) => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [mode, setMode] = useState<"blank" | "template">("blank");
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  const importing = creating && mode === "template";
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  useEffect(() => { if (!open) setError(""); }, [open]);

  const create = async () => {
    if (!name.trim() || (mode === "template" && !url.trim()) || pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    setCreating(true); setError("");
    try {
      const { project } = await api<{ project: Project }>("/api/projects", { method: "POST", signal: controller.signal,
        body: JSON.stringify({ name: name.trim(), ...(mode === "template" ? { templateUrl: url.trim() } : {}) }) });
      if (controller.signal.aborted) return;
      setName(""); setUrl(""); setMode("blank"); onOpenChange(false); onCreated(project.id);
    } catch (reason) {
      if (!isAbortError(reason)) setError(errorMessage(reason));
    } finally { pending.current = null; setCreating(false); }
  };

  const switchTab = (next: "blank" | "template") => { setMode(next); setError(""); };
  const tabKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === "Home" ? "blank" : event.key === "End" ? "template" : mode === "blank" ? "template" : "blank";
    switchTab(next); document.getElementById(`${id}-${next}`)?.focus();
  };
  return <Modal open={open} className={`management-dialog project-import-modal${importing ? " is-importing" : ""}`} title={t("projects.new")}
    description={t("projects.newDescription")}
    onOpenChange={(next) => { if (!creating) { setError(""); onOpenChange(next); } }}
    footer={<><button disabled={creating} onClick={() => onOpenChange(false)}>{t("common.cancel")}</button>
      <button type="submit" form={`${id}-form`} className="primary" disabled={creating || !name.trim() || (mode === "template" && !url.trim())} aria-busy={creating}>
        {creating && <LoaderCircle className="spin" size={14} aria-hidden />}<span role="status">{t(creating ? mode === "template" ? "projects.downloadingTemplate" : "common.loading" : "common.create")}</span>
      </button></>}>
    {importing && <ProjectImportActivity label={t("projects.downloadingTemplate")} />}
    <form id={`${id}-form`} className="new-project-form" aria-busy={creating} onSubmit={(event) => { event.preventDefault(); void create(); }}>
      <div className="share-scope-tabs new-project-tabs" role="tablist" aria-label={t("projects.projectType")}>
        {(["blank", "template"] as const).map((value) => {
          const Icon = value === "blank" ? FileText : FileArchive;
          return <button type="button" id={`${id}-${value}`} key={value} role="tab" aria-selected={mode === value} aria-controls={`${id}-panel`}
            tabIndex={mode === value ? 0 : -1} disabled={creating} onClick={() => switchTab(value)} onKeyDown={tabKey}>
            <Icon aria-hidden size={14} />{t(value === "blank" ? "projects.blankProject" : "projects.templateProject")}
          </button>;
        })}
      </div>
      <div id={`${id}-panel`} className="form-stack" role="tabpanel" aria-labelledby={`${id}-${mode}`}>
        {error && <p className="error dialog-error" role="alert">{error}</p>}
        <label className="form-field">{t("projects.name")}<input autoFocus required maxLength={120} disabled={creating} value={name} onChange={(event) => { setName(event.target.value); setError(""); }} /></label>
        {mode === "template" && <div className="form-field"><div className="new-project-url-label">
          <label htmlFor={`${id}-url`}><Link aria-hidden size={13} />{t("projects.templateZipUrl")}</label>
          <InfoPopover label={t("projects.templateZipUrl")} content={<p><Trans i18nKey="projects.templateZipHelp" values={{ size: maxUploadSizeMB }}
            components={{ templates: <a href="https://latextemplates.com/" target="_blank" rel="noopener noreferrer" /> }} /></p>} />
        </div>
          <input id={`${id}-url`} required type="url" maxLength={4096} spellCheck={false} autoCapitalize="none" autoCorrect="off" disabled={creating} value={url}
            placeholder="https://example.org/template.zip" onChange={(event) => { setUrl(event.target.value); setError(""); }} />
        </div>}
      </div>
    </form>
  </Modal>;
}
