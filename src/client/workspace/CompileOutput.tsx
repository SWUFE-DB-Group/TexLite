import { useTranslation } from "react-i18next";
import { AlertTriangle, Download, Eraser, FileText, LoaderCircle, PackageOpen, ScrollText, Trash2, XCircle } from "lucide-react";
import type { CompileDiagnostic } from "../compileDiagnostics";
import type { FileEntry } from "../types";
import type { CompileArtifact } from "./types";

export function CompileDiagnosticOutput({ diagnostics, files, empty, tone, onJump }: {
  diagnostics: CompileDiagnostic[];
  files: FileEntry[];
  empty: string;
  tone: "warning" | "error";
  onJump: (path: string, line: number, column: number) => void;
}) {
  const { t } = useTranslation();
  const Icon = tone === "error" ? XCircle : AlertTriangle;
  if (!diagnostics.length) return <div className={`compile-empty compile-${tone}`}><Icon size={26} /><span>{empty}</span></div>;
  return <div className={`compile-diagnostic-list compile-${tone}`}>{diagnostics.map((diagnostic, index) => {
    const projectPath = resolveDiagnosticPath(diagnostic.file, files);
    const canJump = Boolean(projectPath && diagnostic.line);
    return <button type="button" disabled={!canJump} className="compile-diagnostic-row" key={`${diagnostic.phase}-${diagnostic.file ?? ""}-${diagnostic.line ?? 0}-${index}`} onClick={() => {
      if (projectPath && diagnostic.line) onJump(projectPath, diagnostic.line, diagnostic.column ?? 1);
    }}>
      <Icon size={15} /><span><strong>{diagnostic.message}</strong><small>{diagnostic.phase}{projectPath ? ` · ${projectPath}${diagnostic.line ? `:${diagnostic.line}` : ""}` : diagnostic.line ? ` · ${t("editor.lineNumber", { line: diagnostic.line })}` : ""}</small></span>
    </button>;
  })}</div>;
}

export function CompileOutput({ lines, empty, tone = "log" }: { lines: string[]; empty: string; tone?: "log" | "warning" | "error" }) {
  const Icon = tone === "error" ? XCircle : tone === "warning" ? AlertTriangle : ScrollText;
  if (!lines.length) return <div className={`compile-empty compile-${tone}`}><Icon size={26} /><span>{empty}</span></div>;
  return <pre className={`compile-output compile-${tone}`}>{lines.join("\n")}</pre>;
}

export function CompileArtifacts({ projectId, mainFile, artifacts, preview, loading, onView }: {
  projectId: string;
  mainFile: string;
  artifacts: CompileArtifact[];
  preview: { path: string; content: string } | null;
  loading: boolean;
  onView: (artifact: CompileArtifact) => void;
}) {
  const { t } = useTranslation();
  const downloadUrl = (filePath: string) => `/api/projects/${projectId}/compile/artifacts?mainFile=${encodeURIComponent(mainFile)}&path=${encodeURIComponent(filePath)}&download=1`;
  if (!artifacts.length) return <div className="compile-empty"><PackageOpen size={26} /><span>{t("editor.noArtifacts")}</span></div>;
  return <div className="artifact-browser">
    <div className="artifact-list">
      {artifacts.map((artifact) => <div className={`artifact-row${preview?.path === artifact.path ? " active" : ""}`} key={artifact.path}>
        <button type="button" disabled={!artifact.viewable} title={artifact.viewable ? t("editor.viewArtifact") : t("editor.downloadToView")} onClick={() => onView(artifact)}>
          <FileText size={14} /><span><strong>{artifact.path}</strong><small>{formatFileSize(artifact.size)}</small></span>
        </button>
        <a href={downloadUrl(artifact.path)} title={t("editor.downloadArtifact")} aria-label={t("editor.downloadArtifact")}><Download size={14} /></a>
      </div>)}
    </div>
    <div className="artifact-preview">
      {loading ? <div className="compile-empty"><LoaderCircle className="spin" size={24} /><span>{t("common.loading")}</span></div>
        : preview ? <><header><strong>{preview.path}</strong><a href={downloadUrl(preview.path)}><Download size={13} />{t("projects.download")}</a></header><pre>{preview.content}</pre></>
          : <div className="compile-empty"><FileText size={24} /><span>{t("editor.selectArtifact")}</span></div>}
    </div>
  </div>;
}

export function CompileCleanup({ mainFile, disabled, cleaning, onCleanCache, onCleanArtifacts }: {
  mainFile: string;
  disabled: boolean;
  cleaning: boolean;
  onCleanCache: () => void;
  onCleanArtifacts: () => void;
}) {
  const { t } = useTranslation();
  return <div className="compile-clean-panel">
    <div className="compile-clean-intro"><AlertTriangle size={28} /><div><strong>{t("editor.cleanTitle")}</strong><p>{t("editor.cleanDescription", { file: mainFile })}</p></div></div>
    <div className="compile-clean-actions">
      <article><div className="compile-clean-action-icon"><Eraser size={19} /></div><div><strong>{t("editor.cleanCache")}</strong><p>{t("editor.cleanCacheDescription")}</p><button type="button" disabled={disabled || cleaning} onClick={onCleanCache}>{cleaning ? <LoaderCircle className="spin" size={14} /> : <Eraser size={14} />}{t("editor.cleanCache")}</button></div></article>
      <article className="danger"><div className="compile-clean-action-icon"><Trash2 size={19} /></div><div><strong>{t("editor.cleanArtifacts")}</strong><p>{t("editor.cleanArtifactsDescription")}</p><button type="button" className="danger" disabled={disabled || cleaning} onClick={onCleanArtifacts}>{cleaning ? <LoaderCircle className="spin" size={14} /> : <Trash2 size={14} />}{t("editor.cleanArtifacts")}</button></div></article>
    </div>
  </div>;
}

function resolveDiagnosticPath(input: string | undefined, files: FileEntry[]): string | null {
  if (!input) return null;
  const filePaths = files.filter((entry) => entry.type === "file").map((entry) => entry.path);
  const normalized = input.replaceAll("\\", "/").replace(/^\.\//, "");
  if (filePaths.includes(normalized)) return normalized;
  const suffixMatches = filePaths.filter((filePath) => normalized.endsWith(`/${filePath}`));
  if (suffixMatches.length === 1) return suffixMatches[0];
  const basename = normalized.split("/").at(-1);
  const basenameMatches = filePaths.filter((filePath) => filePath.split("/").at(-1) === basename);
  return basenameMatches.length === 1 ? basenameMatches[0] : null;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
