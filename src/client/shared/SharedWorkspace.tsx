import { lazy, Suspense, useEffect, useId, useMemo, useState, type ReactNode } from "react";
import * as Popover from "@radix-ui/react-popover";
import { ChevronDown, ChevronRight, FileClock, FolderOpen, GitBranch, GripVertical, Languages, LoaderCircle, LockKeyhole, MessageSquare, Palette, PanelLeftClose, PanelLeftOpen, Play, RefreshCw, Settings, TerminalSquare, Users, X } from "lucide-react";
import { Group, Panel, Separator, usePanelRef, type PanelImperativeHandle } from "react-resizable-panels";
import type { RefObject } from "react";
import { useTranslation } from "react-i18next";
import type { SharedProjectData } from "../../shared/projectViewLinks";
import { appLocale } from "../../shared/locales";
import { FileTypeIcon } from "../fileIcons";
import { PdfDocumentIcon } from "../PdfDocumentIcon";
import { ThemeSwitcher } from "../ThemeSwitcher";
import { formatBytes } from "../formatBytes";
import { formatDateTime } from "../dateTime";
import { defaultEditorPreferences } from "../editorPreferences";
import { WorkspaceLayoutMenu } from "../workspace/WorkspaceChrome";
import { WorkspaceTopbarFrame } from "../workspace/WorkspaceTopbarFrame";
import { WorkspacePreviewHeader } from "../workspace/WorkspacePreviewHeader";
import { WorkspaceOutlinePanel } from "../workspace/WorkspaceFilePanel";
import type { SourceCursorStore } from "../workspace/sourceCursorStore";
import type { WorkspaceLayout } from "../workspace/types";
import { usePhoneWorkspace } from "../workspace/usePhoneWorkspace";
import { WorkspaceMobileDrawer } from "../workspace/WorkspaceMobileDrawer";

const PdfPreview = lazy(() => import("../PdfPreview").then((module) => ({ default: module.PdfPreview })));
const noop = () => undefined;

function ReaderSettings() {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const languageId = useId();
  return <Popover.Root open={open} onOpenChange={setOpen}>
    <Popover.Trigger asChild><button type="button" className={open ? "active" : ""} aria-label={t("common.settings")} title={t("common.settings")}><Settings size={15} /><span className="workspace-action-label workspace-action-label-persistent">{t("common.settings")}</span></button></Popover.Trigger>
    <Popover.Portal><Popover.Content className="user-menu-content shared-reader-settings" align="end" sideOffset={10} collisionPadding={12} aria-label={t("common.settings")}>
      <div className="user-menu-settings"><div className="user-menu-language">
        <label htmlFor={languageId}><Languages size={16} />{t("common.language")}</label><div className="user-menu-language-select"><select id={languageId} value={appLocale(i18n.resolvedLanguage)} onChange={(event) => void i18n.changeLanguage(event.target.value)}>
          <option value="en">{t("common.languageEnglish")}</option><option value="zh">{t("common.languageChinese")}</option><option value="zh-Hant">{t("common.languageTraditionalChinese")}</option>
        </select><ChevronDown size={13} aria-hidden /></div>
      </div><div className="user-menu-theme"><span className="user-menu-setting-label"><Palette size={16} />{t("theme.title")}</span><ThemeSwitcher /></div></div>
    </Popover.Content></Popover.Portal>
  </Popover.Root>;
}

export function SharedWorkspaceTopbar({ data, path = "", loading, onRefresh, children }: {
  data?: SharedProjectData; path?: string; loading: boolean; onRefresh: () => void; children?: ReactNode;
}) {
  const { t, i18n } = useTranslation();
  const expiry = data?.expiresAt ? t("viewLinks.expires", { time: formatDateTime(data.expiresAt, i18n.resolvedLanguage) }) : t("viewLinks.readOnly");
  return <WorkspaceTopbarFrame siteName={data?.siteName ?? "TexLite"} projectName={data?.project.name ?? "TexLite"}
    subtitle={path || t("viewLinks.readOnly")}
    titleAccessory={data && <span className="shared-reader-access" tabIndex={0} title={expiry} data-texlite-tooltip-always><LockKeyhole size={13} aria-hidden />{t("viewLinks.readOnly")}</span>}>
    {children}
    {data && <>
      <button type="button" className="share-action" disabled aria-label={t("projectSettings.share")}><Users size={15} /><span className="workspace-action-label">{t("projectSettings.share")}</span></button>
      <button type="button" className="snapshots-action" disabled aria-label={t("history.projectSnapshots")}><FileClock size={15} /><span className="workspace-action-label">{t("history.projectSnapshotsButton")}</span></button>
      <button type="button" className="comments-action" disabled aria-label={t("common.comments")}><MessageSquare size={15} /><span className="workspace-action-label">{t("common.comments")}</span></button>
      <button type="button" className="git-action" disabled aria-label={t("git.title")}><GitBranch size={15} /><span className="workspace-action-label">Git</span></button>
      <button type="button" className="reader-terminal-action" disabled aria-label={t("agents.terminal")}><TerminalSquare size={15} /><span className="workspace-action-label">{t("agents.terminal")}</span></button>
    </>}
    <button type="button" disabled={loading} aria-label={t("viewLinks.refresh")} title={t("viewLinks.refresh")} onClick={onRefresh}><RefreshCw size={15} /><span className="workspace-action-label">{t("viewLinks.refresh")}</span></button>
    <ReaderSettings />
    {data && <button type="button" className="compile" disabled aria-label={t("editor.compile", { engine: data.project.engine })}><Play size={15} /><span className="workspace-action-label workspace-action-label-persistent">{t("editor.compileShort")}<span className="compile-engine-label"> · {data.project.engine}</span></span></button>}
  </WorkspaceTopbarFrame>;
}

/** File-tree layout is display-only. No authenticated project hooks are mounted. */
export function SharedWorkspace({ data, path, loading, error, onRefresh, onOpenFile, onJumpToSource, sourceCursorStore, children }: {
  data: SharedProjectData; path: string; loading: boolean; error: string; onRefresh: () => void;
  onOpenFile: (path: string) => void; onJumpToSource: (path: string, line: number, column: number) => void;
  sourceCursorStore: SourceCursorStore; children: ReactNode;
}) {
  const { t, i18n } = useTranslation();
  const phone = usePhoneWorkspace();
  const [preferredLayout, setPreferredLayout] = useState<WorkspaceLayout>(() => typeof window.matchMedia === "function" && window.matchMedia("(max-width: 900px)").matches ? "editor-only" : "editor-pdf");
  const layout = phone && preferredLayout === "editor-pdf" ? "editor-only" : preferredLayout;
  const setLayout = (value: WorkspaceLayout) => { setPreferredLayout(phone && value === "editor-pdf" ? "editor-only" : value); setPhoneFilesOpen(false); };
  const [phoneFilesOpen, setPhoneFilesOpen] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [selectedFolder, setSelectedFolder] = useState<string | null>(null);
  const [filesCollapsed, setFilesCollapsed] = useState(false);
  const [showSizes, setShowSizes] = useState(false);
  const filesPanel = usePanelRef();
  const showEditor = layout !== "pdf-only", showPreview = layout !== "editor-only";
  useEffect(() => {
    setSelectedFolder(null);
    setExpanded((current) => {
      const next = new Set(current), parts = path.split("/");
      for (let index = 1; index < parts.length; index++) next.add(parts.slice(0, index).join("/"));
      return next;
    });
  }, [path]);
  const visible = useMemo(() => {
    const children = new Map<string, SharedProjectData["files"]>();
    for (const file of data.files) {
      const parent = file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/")) : "";
      const entries = children.get(parent) ?? []; entries.push(file); children.set(parent, entries);
    }
    const result: SharedProjectData["files"] = [];
    const visit = (parent: string) => {
      const siblings = [...(children.get(parent) ?? [])].sort((a, b) => a.type === b.type ? a.path.localeCompare(b.path) : a.type === "directory" ? -1 : 1);
      for (const file of siblings) { result.push(file); if (file.type === "directory" && expanded.has(file.path)) visit(file.path); }
    };
    visit(""); return result;
  }, [data.files, expanded]);
  const compiledAt = data.pdf?.compiledAt ?? null;
  const compiledLabel = compiledAt ? formatDateTime(compiledAt, i18n.resolvedLanguage, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "";
  return <>
    <SharedWorkspaceTopbar data={data} path={path} loading={loading} onRefresh={onRefresh}>
      {showEditor && <button type="button" className={`files-action${(phone ? phoneFilesOpen : !filesCollapsed) ? " active" : ""}`} aria-label={t("common.files")} title={t("common.files")} aria-expanded={phone ? phoneFilesOpen : !filesCollapsed} onClick={() => {
        if (phone) { setPhoneFilesOpen((value) => !value); return; }
        if (filesPanel.current?.isCollapsed()) filesPanel.current.expand(); else filesPanel.current?.collapse();
      }}>{filesCollapsed ? <PanelLeftOpen size={15} /> : <PanelLeftClose size={15} />}<span className="workspace-action-label">{t("common.files")}</span></button>}
      <WorkspaceLayoutMenu value={layout} onChange={setLayout} workspacePrimary />
    </SharedWorkspaceTopbar>
    {error && <div className="shared-reader-error error" role="alert">{error}</div>}
    <Group orientation="horizontal" className="work-grid shared-reader-workspace">
      {showEditor && <>
        <ReaderFiles phone={phone} open={phoneFilesOpen} onClose={() => setPhoneFilesOpen(false)} filesPanel={filesPanel} onCollapsed={setFilesCollapsed}>
          <aside className="left-panel"><section className="files-panel">
            <div className="panel-title"><button type="button" className="file-size-toggle" aria-pressed={showSizes} title={t(showSizes ? "editor.hideFileSizes" : "editor.showFileSizes")} onClick={() => setShowSizes((current) => !current)}>{t("common.files")}</button></div>
            <div className={`file-list shared-reader-files${selectedFolder !== null ? " folder-selected" : ""}`} style={{ fontSize: defaultEditorPreferences.fontSize }}>
              {visible.map((file) => {
                const directory = file.type === "directory", depth = file.path.split("/").length - 1, name = file.path.split("/").at(-1);
                return <div key={file.path} className={`file-entry${directory ? ` folder-entry${selectedFolder === file.path ? " selected" : ""}` : selectedFolder === null && path === file.path ? " active" : ""}`} style={{ paddingLeft: depth * 13 + (directory ? 5 : 18) }}>
                  <button type="button" className="file-entry-main" aria-expanded={directory ? expanded.has(file.path) : undefined} onClick={() => {
                    if (directory) { setSelectedFolder(file.path); setExpanded((current) => { const next = new Set(current); if (next.has(file.path)) next.delete(file.path); else next.add(file.path); return next; }); }
                    else { setSelectedFolder(null); onOpenFile(file.path); if (phone) setPhoneFilesOpen(false); }
                  }}>{directory ? <>{expanded.has(file.path) ? <ChevronDown size={13} /> : <ChevronRight size={13} />}<FolderOpen size={14} /></> : <FileTypeIcon path={file.path} />}<span>{name}</span>{!directory && file.path === data.project.mainFile && <small>{t("editor.currentMainShort")}</small>}</button>
                  {showSizes && file.type === "file" && file.size != null && <span className="file-entry-size">{formatBytes(file.size)}</span>}
                </div>;
              })}
            </div>
          </section><WorkspaceOutlinePanel outline={data.outline} activeFile={path} activeMainFile={data.project.mainFile} sourceCursorStore={sourceCursorStore} jumpToSource={(...args) => { onJumpToSource(...args); if (phone) setPhoneFilesOpen(false); }} /></aside>
        </ReaderFiles>
        {!phone && <Separator className="resize-handle" aria-label={t("common.files")}><GripVertical size={12} /></Separator>}
        <Panel id="source" minSize="22%"><section className="source-panel"><div className="editor-content-container shared-reader-source">{children}</div></section></Panel>
      </>}
      {showEditor && showPreview && <Separator className="resize-handle" aria-label={t("viewLinks.pdf")}><GripVertical size={12} /></Separator>}
      {showPreview && <Panel id="preview" minSize="22%"><section className="preview-panel shared-reader-pdf">
        <WorkspacePreviewHeader mainFile={data.project.mainFile} targetLabel={data.project.mainFile.split("/").at(-1) ?? data.project.mainFile} compiledAt={compiledAt} compiledLabel={compiledLabel}
          sizeBytes={data.pdf?.size ?? null} downloadUrl={data.pdf ? `${data.pdf.url}&download=1` : ""} activeSurface="pdf" onSelect={noop} diagnosticCount={0} diagnosticsDisabled />
        <div className="preview-content preview-pdf">{data.pdf ? <Suspense fallback={<div className="pdf-loading-state" role="status"><LoaderCircle className="spin" size={24} /><span>{t("editor.loadingPdf")}</span></div>}><PdfPreview key={data.pdf.url} url={data.pdf.url} loadingMode={data.pdf.loadingMode} target={null} onViewportLocation={noop} /></Suspense>
          : <div className="preview-empty preview-empty-uncompiled" role="status"><span className="preview-empty-icon"><PdfDocumentIcon size={32} /></span><strong>{t("editor.previewEmptyTitle")}</strong><p>{t("viewLinks.noPdf")}</p></div>}</div>
      </section></Panel>}
    </Group>
  </>;
}

function ReaderFiles({ phone, open, onClose, filesPanel, onCollapsed, children }: {
  phone: boolean; open: boolean; onClose: () => void; filesPanel: RefObject<PanelImperativeHandle | null>;
  onCollapsed: (collapsed: boolean) => void; children: ReactNode;
}) {
  const { t } = useTranslation();
  if (phone) return <WorkspaceMobileDrawer files open={open} title={t("common.files")} onClose={onClose}>
    <button className="workspace-mobile-files-close" type="button" aria-label={t("common.close")} onClick={onClose}><X size={18} /></button>{children}
  </WorkspaceMobileDrawer>;
  return <Panel id="files" panelRef={filesPanel} defaultSize="16%" minSize="100px" maxSize="35%" collapsible collapsedSize="0%" onResize={(size) => onCollapsed(size.asPercentage === 0)}>{children}</Panel>;
}
