import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { AlertCircle, AlertTriangle, AlignLeft, BookOpen, CheckCircle2, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, FileCheck2, LoaderCircle, MessageCircleQuestion, PanelsTopLeft, RefreshCw, Save, Settings, Sigma, SpellCheck2, Type, WrapText, X } from "lucide-react";
import { api } from "../api";
import { texFmtToolStatus, type ClientToolRuntimeState } from "../clientToolStatus";
import { editorFonts, type EditorPreferences } from "../editorPreferences";
import { errorMessage } from "../errors";
import { preloadTexFmt, reloadTexFmt } from "../latexFormatter";
import type { FileEntry, Project, SiteConfig } from "../types";
import { projectLatexmkrcCandidates } from "./projectLatexmkrc";

function BrowserToolStatus({ name, state, label, reloadLabel, onReload, compact = false }: {
  name: string; state: ClientToolRuntimeState; label: string; reloadLabel: string; onReload: () => void; compact?: boolean;
}) {
  const icon = state.status === "loading"
    ? <LoaderCircle className="spin" size={14} />
    : state.status === "working"
      ? <CheckCircle2 size={14} />
      : <AlertCircle size={14} />;
  const contents = <>
    {icon}<strong>{name}</strong><span>{label}</span>
    {state.status === "error" && <button type="button" className="browser-tool-reload" title={reloadLabel} aria-label={reloadLabel} onClick={onReload}>
      <RefreshCw size={12} />{reloadLabel}
    </button>}
  </>;
  if (compact) return <span className={`browser-tool-status compact ${state.status}`} role="status" aria-live="polite" aria-label={`${name}: ${label}`} title={state.error || undefined}>
    {icon}<span>{label}</span>
    {state.status === "error" && <button type="button" className="browser-tool-reload" title={reloadLabel} aria-label={reloadLabel} onClick={onReload}><RefreshCw size={12} /></button>}
  </span>;
  return <div className={`browser-tool-status ${state.status}`} title={state.error || undefined}>{contents}</div>;
}

export function ProjectSettings({ onClose, project, projectId, site, files, dictionaryWords, onDictionaryChange, editorPreferences, onEditorPreferences, spellCheckCount, spellCheckUniqueCount, spellCheckIndex, onSpellCheckNavigate, onProject }: {
  onClose: () => void;
  project: Project; projectId: string; site: SiteConfig; files: FileEntry[]; dictionaryWords: string[];
  onDictionaryChange: (words: string[]) => void;
  editorPreferences: EditorPreferences; onEditorPreferences: (preferences: EditorPreferences) => void;
  spellCheckCount: number | null; spellCheckUniqueCount: number | null; spellCheckIndex: number;
  onSpellCheckNavigate: (index: number) => void;
  onProject: (project: Project) => void;
}) {
  const { t } = useTranslation();
  const [engine, setEngine] = useState(project.engine);
  const [rcEnabled, setRcEnabled] = useState(Boolean(project.latexmkrc));
  const [name, setName] = useState(project.name);
  const [mainFile, setMainFile] = useState(project.mainFile);
  const [chktexEnabled, setChktexEnabled] = useState(project.chktexEnabled);
  const [savingCompiler, setSavingCompiler] = useState(false);
  const compilerSaveRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  const savedCompilerSettings = useRef({
    name: project.name, mainFile: project.mainFile, engine: project.engine,
    latexmkrc: project.latexmkrc, chktexEnabled: project.chktexEnabled
  });
  const [mainFileOptions, setMainFileOptions] = useState<string[] | null>(null);
  const [error, setError] = useState("");
  const [dictionaryValue, setDictionaryValue] = useState("");
  const [dictionaryError, setDictionaryError] = useState("");
  const [harperCliStatus, setHarperCliStatus] = useState<"checking" | "available" | "unavailable" | "error">("checking");
  const [harperProbeToken, setHarperProbeToken] = useState(0);
  const [settingsTab, setSettingsTab] = useState<"appearance" | "compiler">("appearance");
  const [appearancePreferences, setAppearancePreferences] = useState(editorPreferences);
  const texFmtStatus = useSyncExternalStore(texFmtToolStatus.subscribe, texFmtToolStatus.getSnapshot, texFmtToolStatus.getSnapshot);
  const canManage = project.permission === "owner";
  const canEdit = project.permission !== "read";
  const canManageDictionary = project.permission !== "read";
  useEffect(() => setAppearancePreferences(editorPreferences), [editorPreferences]);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  useEffect(() => {
    // Opening settings eagerly initializes the browser formatter Worker.
    void preloadTexFmt().catch(texFmtToolStatus.failed);
  }, [projectId]);
  useEffect(() => {
    const controller = new AbortController();
    setHarperCliStatus("checking");
    void api<{ available: boolean }>(`/api/projects/${projectId}/spellcheck/status`, { signal: controller.signal })
      .then((result) => {
        if (!controller.signal.aborted) setHarperCliStatus(result.available ? "available" : "unavailable");
      })
      .catch(() => {
        // A network/authentication error is not evidence of a missing CLI.
        if (!controller.signal.aborted) setHarperCliStatus("error");
      });
    return () => controller.abort();
  }, [projectId, harperProbeToken]);
  const reloadTexFmtRuntime = () => {
    void reloadTexFmt().catch(texFmtToolStatus.failed);
  };
  const rcFiles = projectLatexmkrcCandidates(files, project.latexmkrc);
  const selectedRcPath = project.latexmkrc && rcFiles.includes(project.latexmkrc) ? project.latexmkrc : rcFiles[0] ?? "";
  const selectedRcMissing = files.length > 0 && project.latexmkrc !== null && !rcFiles.includes(project.latexmkrc);
  useEffect(() => {
    if (selectedRcMissing) setRcEnabled(false);
  }, [selectedRcMissing]);
  useEffect(() => {
    if (settingsTab !== "compiler") return;
    const controller = new AbortController();
    setMainFileOptions(null);
    void api<{ mainFiles: string[] }>(`/api/projects/${projectId}/main-files`, { signal: controller.signal })
      .then((result) => setMainFileOptions(result.mainFiles))
      .catch((requestError) => {
        if (requestError instanceof Error && requestError.name === "AbortError") return;
        setError(errorMessage(requestError));
      });
    return () => controller.abort();
  }, [projectId, files, settingsTab]);
  const displayedMainFileOptions = mainFileOptions ?? [project.mainFile];
  const invalidCurrentMainFile = mainFileOptions !== null && !mainFileOptions.includes(mainFile);
  const saveCompilerSettings = async () => {
    if (compilerSaveRef.current) return;
    const latexmkrc = files.length === 0 && project.latexmkrc && site.allowProjectLatexmkrc !== false
      ? project.latexmkrc
      : rcEnabled && site.allowProjectLatexmkrc !== false ? selectedRcPath || null : null;
    const previous = savedCompilerSettings.current;
    const changes: Record<string, string | boolean | null> = {};
    if (name !== previous.name) changes.name = name;
    if (mainFile !== previous.mainFile) changes.mainFile = mainFile;
    if (engine !== previous.engine) changes.engine = engine;
    if (latexmkrc !== previous.latexmkrc) changes.latexmkrc = latexmkrc;
    if (chktexEnabled !== previous.chktexEnabled) changes.chktexEnabled = chktexEnabled;
    if (Object.keys(changes).length === 0) return;
    const expectedSettings = Object.fromEntries(
      Object.keys(changes).map((field) => [field, previous[field as keyof typeof previous]])
    );
    const controller = new AbortController();
    compilerSaveRef.current = controller;
    setSavingCompiler(true);
    try {
      setError("");
      const result = await api<{ project: Project }>(`/api/projects/${projectId}`, {
        method: "PATCH", signal: controller.signal, body: JSON.stringify({ ...changes, expectedSettings })
      });
      if (!mountedRef.current) {
        // Closing settings does not cancel a save already accepted by the
        // server. Keep the workspace metadata current when it completes.
        onProject(result.project);
        return;
      }
      savedCompilerSettings.current = {
        name: result.project.name, mainFile: result.project.mainFile, engine: result.project.engine,
        latexmkrc: result.project.latexmkrc, chktexEnabled: result.project.chktexEnabled
      };
      setName(result.project.name);
      setMainFile(result.project.mainFile);
      setEngine(result.project.engine);
      setChktexEnabled(result.project.chktexEnabled);
      setRcEnabled(Boolean(result.project.latexmkrc));
      onProject(result.project);
    } catch (requestError) {
      if (mountedRef.current) setError(errorMessage(requestError));
    } finally {
      if (compilerSaveRef.current === controller) {
        compilerSaveRef.current = null;
        if (mountedRef.current) setSavingCompiler(false);
      }
    }
  };
  const saveAppearanceSettings = () => onEditorPreferences(appearancePreferences);
  const saveCurrentSettings = () => {
    if (settingsTab === "appearance") return saveAppearanceSettings();
    if (canManage) void saveCompilerSettings();
  };
  const headerSaveLabel = settingsTab === "appearance" ? t("projectSettings.saveAppearance") : t("projectSettings.saveCompiler");
  const canSaveCurrentTab = settingsTab === "appearance" || canManage;
  const addDictionaryWord = async () => {
    const word = dictionaryValue.trim();
    if (!word) return;
    try {
      const result = await api<{ words: string[] }>(`/api/projects/${projectId}/dictionary`, {
        method: "POST", body: JSON.stringify({ word })
      });
      onDictionaryChange(result.words);
      setDictionaryValue("");
      setDictionaryError("");
    } catch (requestError) { setDictionaryError(errorMessage(requestError)); }
  };
  const removeDictionaryWord = async (word: string) => {
    try {
      const result = await api<{ words: string[] }>(`/api/projects/${projectId}/dictionary/${encodeURIComponent(word)}`, { method: "DELETE" });
      onDictionaryChange(result.words);
      setDictionaryError("");
    } catch (requestError) { setDictionaryError(errorMessage(requestError)); }
  };
  return <><div className="drawer-title settings-drawer-title"><strong>{t("editor.projectSettings")}</strong><div className="drawer-title-actions">{canSaveCurrentTab && <button type="button" className="drawer-settings-save" disabled={settingsTab === "compiler" && savingCompiler} aria-busy={settingsTab === "compiler" && savingCompiler} onClick={saveCurrentSettings}>{settingsTab === "compiler" && savingCompiler ? <LoaderCircle className="spin" size={14} /> : <Save size={14} />}<span>{headerSaveLabel}</span></button>}<button type="button" aria-label={t("common.close")} onClick={onClose}><X size={17} /></button></div></div><div className="settings padded">
    {error && <p className="error">{error}</p>}
    <div className="settings-tabs" role="tablist" aria-label={t("common.settings")}>
      <button id="settings-tab-appearance" type="button" role="tab" aria-selected={settingsTab === "appearance"} aria-controls="settings-panel-appearance" className={`settings-tab${settingsTab === "appearance" ? " active" : ""}`} onClick={() => setSettingsTab("appearance")}>
        <Type size={15} />{t("projectSettings.editorTab")}
      </button>
      <button id="settings-tab-compiler" type="button" role="tab" aria-selected={settingsTab === "compiler"} aria-controls="settings-panel-compiler" className={`settings-tab${settingsTab === "compiler" ? " active" : ""}`} onClick={() => setSettingsTab("compiler")}>
        <Settings size={15} />{t("projectSettings.compilerTab")}
      </button>
    </div>
    {settingsTab === "appearance" ? <section id="settings-panel-appearance" role="tabpanel" aria-labelledby="settings-tab-appearance">
      <div className="settings-section-title"><Type size={15} /><strong>{t("projectSettings.editorAppearance")}</strong></div>
      <p className="settings-description appearance-description">{t("projectSettings.editorAppearanceDescription")}</p>
      <label>{t("projectSettings.fontFamily")}<select value={appearancePreferences.font} onChange={(event) => setAppearancePreferences({ ...appearancePreferences, font: event.target.value as EditorPreferences["font"] })}>{editorFonts.map((font) => <option value={font.id} key={font.id}>{t(font.labelKey)}</option>)}</select></label>
      <label>{t("projectSettings.fontSize")}<select value={appearancePreferences.fontSize} onChange={(event) => setAppearancePreferences({ ...appearancePreferences, fontSize: Number(event.target.value) })}>{[12, 13, 14, 15, 16, 18, 20].map((size) => <option value={size} key={size}>{size} px</option>)}</select></label>
      <label>{t("projectSettings.lineHeight")}<select value={appearancePreferences.lineHeight} onChange={(event) => setAppearancePreferences({ ...appearancePreferences, lineHeight: Number(event.target.value) })}><option value={1.45}>{t("projectSettings.lineHeightCompact")}</option><option value={1.65}>{t("projectSettings.lineHeightNormal")}</option><option value={1.85}>{t("projectSettings.lineHeightRelaxed")}</option></select></label>
      <label className="editor-checkbox"><input type="checkbox" checked={appearancePreferences.lineWrapping} onChange={(event) => setAppearancePreferences({ ...appearancePreferences, lineWrapping: event.target.checked })} /><WrapText size={15} /><span>{t("projectSettings.lineWrapping")}</span></label>
      <div className="editor-preference">
        <label className="editor-checkbox"><input type="checkbox" checked={appearancePreferences.showTooltips} onChange={(event) => setAppearancePreferences({ ...appearancePreferences, showTooltips: event.target.checked })} /><MessageCircleQuestion size={15} /><span>{t("projectSettings.showTooltips")}</span></label>
        <p className="field-hint">{t("projectSettings.showTooltipsDescription")}</p>
      </div>
      <div className="editor-preference">
        <label className="editor-checkbox"><input type="checkbox" checked={appearancePreferences.mathPreviewOnHover} onChange={(event) => setAppearancePreferences({ ...appearancePreferences, mathPreviewOnHover: event.target.checked })} /><Sigma size={15} /><span>{t("projectSettings.mathPreviewOnHover")}</span></label>
        <p className="field-hint">{t("projectSettings.mathPreviewOnHoverDescription")}</p>
      </div>
      <div className="editor-preference">
        <label className="editor-checkbox"><input type="checkbox" checked={appearancePreferences.spellCheck} onChange={(event) => setAppearancePreferences({ ...appearancePreferences, spellCheck: event.target.checked })} /><span>{t("projectSettings.spellCheck")}</span></label>
        <p className="field-hint">{t("projectSettings.writingCheckDescription")} <a href="https://writewithharper.com/docs/integrations/language-server" target="_blank" rel="noreferrer">Harper</a></p>
        {spellCheckCount !== null && <div className={`spell-check-result${spellCheckCount ? " has-issues" : ""}`} role="status" aria-live="polite"><SpellCheck2 size={14} /><span>{spellCheckCount ? t("projectSettings.writingIssues", { count: spellCheckCount, uniqueCount: spellCheckUniqueCount ?? 0 }) : t("chktex.noIssues")}</span>{spellCheckCount > 0 && <span className="spell-check-controls"><button type="button" title={t("projectSettings.spellCheckFirst")} aria-label={t("projectSettings.spellCheckFirst")} disabled={spellCheckIndex <= 0} onClick={() => onSpellCheckNavigate(0)}><ChevronsLeft size={14} /></button><button type="button" title={t("projectSettings.spellCheckPrevious")} aria-label={t("projectSettings.spellCheckPrevious")} disabled={spellCheckIndex <= 0} onClick={() => onSpellCheckNavigate(spellCheckIndex - 1)}><ChevronLeft size={14} /></button><span className="spell-check-position">{t("projectSettings.spellCheckPosition", { current: Math.min(spellCheckIndex + 1, spellCheckCount), total: spellCheckCount })}</span><button type="button" title={t("projectSettings.spellCheckNext")} aria-label={t("projectSettings.spellCheckNext")} disabled={spellCheckIndex >= spellCheckCount - 1} onClick={() => onSpellCheckNavigate(spellCheckIndex + 1)}><ChevronRight size={14} /></button><button type="button" title={t("projectSettings.spellCheckLast")} aria-label={t("projectSettings.spellCheckLast")} disabled={spellCheckIndex >= spellCheckCount - 1} onClick={() => onSpellCheckNavigate(spellCheckCount - 1)}><ChevronsRight size={14} /></button></span>}</div>}
      </div>
      <div className="editor-preference">
        <label className="editor-checkbox"><input type="checkbox" checked={appearancePreferences.vimMode} onChange={(event) => setAppearancePreferences({ ...appearancePreferences, vimMode: event.target.checked })} /><span>{t("projectSettings.vimMode")}</span></label>
        <p className="field-hint">{t("projectSettings.vimModeDescription")} <a href="https://replit-codemirror-vim.mintlify.app/" target="_blank" rel="noreferrer">{t("projectSettings.vimHelp")}</a></p>
      </div>
      <div className="editor-preference">
        <label className="editor-checkbox"><input type="checkbox" checked={appearancePreferences.openFilesInTabs} onChange={(event) => setAppearancePreferences({ ...appearancePreferences, openFilesInTabs: event.target.checked })} /><PanelsTopLeft size={15} /><span>{t("projectSettings.openFilesInTabs")}</span></label>
        <p className="field-hint">{t("projectSettings.openFilesInTabsDescription")}</p>
      </div>
      <div className="editor-preference">
        <label className="editor-checkbox"><input type="checkbox" disabled={!canEdit} checked={appearancePreferences.formatOnCompile} onChange={(event) => setAppearancePreferences({ ...appearancePreferences, formatOnCompile: event.target.checked })} /><AlignLeft size={15} /><span>{t("projectSettings.formatOnCompile")}</span></label>
        <p className="field-hint">{t(canEdit ? "projectSettings.formatOnCompileDescription" : "projectSettings.formatRequiresWrite")} {t("projectSettings.formatterDescription")} <a href="https://www.npmjs.com/package/tex-fmt" target="_blank" rel="noreferrer">{t("projectSettings.formatterInstall")}</a> · <a href="https://github.com/FlamingTempura/bibtex-tidy" target="_blank" rel="noreferrer">{t("projectSettings.bibtexTidyInstall")}</a></p>
      </div>
      <div className="editor-preference">
        <label className="tex-fmt-options-field"><span className="tex-fmt-options-heading"><span>{t("projectSettings.texFmtOptions")}</span><BrowserToolStatus compact name="tex-fmt" state={texFmtStatus} label={t(`projectSettings.toolStatus.${texFmtStatus.status}`)} reloadLabel={t("projectSettings.reloadTool")} onReload={reloadTexFmtRuntime} /></span><textarea className="tex-fmt-options-editor" rows={6} maxLength={16 * 1024} spellCheck={false} value={appearancePreferences.texFmtConfig} placeholder={t("projectSettings.texFmtOptionsPlaceholder")} onChange={(event) => setAppearancePreferences({ ...appearancePreferences, texFmtConfig: event.target.value })} /></label>
        <p className="field-hint">{t("projectSettings.texFmtOptionsDescription")}</p>
      </div>
      <div className="settings-section-title dictionary-heading"><BookOpen size={15} /><strong>{t("projectSettings.dictionary")}</strong><span className={`harper-cli-status ${harperCliStatus}`} role="status" aria-live="polite">
        {harperCliStatus === "checking" ? <LoaderCircle className="spin" size={12} aria-hidden="true" /> : harperCliStatus === "available" ? <CheckCircle2 size={12} aria-hidden="true" /> : <AlertCircle size={12} aria-hidden="true" />}
        <span>Harper CLI · {t(`projectSettings.harperCliStatus.${harperCliStatus}`)}</span>
        {(harperCliStatus === "error" || harperCliStatus === "unavailable") && <button type="button" title={t("projectSettings.harperCliRetry")} aria-label={t("projectSettings.harperCliRetry")} onClick={() => setHarperProbeToken((value) => value + 1)}><RefreshCw size={12} /></button>}
      </span></div>
      <p className="settings-description">{t("projectSettings.dictionaryDescription")}</p>
      {dictionaryError && <p className="error dictionary-error">{dictionaryError}</p>}
      {canManageDictionary && <div className="dictionary-add"><input value={dictionaryValue} placeholder={t("projectSettings.dictionaryPlaceholder")} onChange={(event) => setDictionaryValue(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void addDictionaryWord(); } }} /><button type="button" disabled={!dictionaryValue.trim()} onClick={() => void addDictionaryWord()}>{t("projectSettings.addWord")}</button></div>}
      <div className="dictionary-words">{dictionaryWords.map((word) => <span className="dictionary-word" key={word}><code>{word}</code>{canManageDictionary && <button type="button" title={t("common.delete")} aria-label={`${t("common.delete")} ${word}`} onClick={() => void removeDictionaryWord(word)}><X size={13} /></button>}</span>)}{dictionaryWords.length === 0 && <span className="dictionary-empty">{t("projectSettings.dictionaryEmpty")}</span>}</div>
      <div className="settings-actions"><button className="settings-save" onClick={saveAppearanceSettings}><Save size={15} />{t("projectSettings.saveAppearance")}</button></div>
    </section> : <section id="settings-panel-compiler" role="tabpanel" aria-labelledby="settings-tab-compiler">
      <div className="settings-section-title"><Settings size={15} /><strong>{t("projectSettings.compilerTab")}</strong></div>
      <p className="settings-description compiler-description">{t("projectSettings.compilerDescription")}</p>
      <label>{t("projects.name")}<input disabled={!canManage || savingCompiler} value={name} onChange={(event) => setName(event.target.value)} /></label>
      <label>{t("projectSettings.mainFile")}<select disabled={!canManage || savingCompiler || mainFileOptions === null || mainFileOptions.length === 0} value={mainFile} onChange={(event) => setMainFile(event.target.value)}>{invalidCurrentMainFile && <option value={mainFile} disabled>{t("projectSettings.invalidMainFileOption", { path: mainFile })}</option>}{displayedMainFileOptions.map((filePath) => <option value={filePath} key={filePath}>{filePath}</option>)}</select></label>
      <label>{t(rcEnabled && rcFiles.length > 0 && site.allowProjectLatexmkrc !== false ? "projectSettings.defaultEngine" : "projectSettings.engine")}<select disabled={!canManage || savingCompiler} value={engine} onChange={(event) => setEngine(event.target.value as Project["engine"])}>{(site.allowedEngines ?? ["pdflatex", "xelatex", "lualatex"]).map((item) => <option key={item}>{item}</option>)}</select></label>
      <div className="editor-preference compiler-check-option"><label className="editor-checkbox"><input type="checkbox" disabled={!canManage || savingCompiler} checked={chktexEnabled} onChange={(event) => setChktexEnabled(event.target.checked)} /><FileCheck2 size={15} /><span>{t("chktex.enabled")}</span></label><p className="field-hint">{t("chktex.description")} <a href="https://www.nongnu.org/chktex/" target="_blank" rel="noreferrer">ChkTeX</a></p></div>
      {rcFiles.length > 0 && <div className="editor-preference latexmkrc-setting">
        <label className="editor-checkbox"><input type="checkbox" disabled={!canManage || savingCompiler || site.allowProjectLatexmkrc === false} checked={rcEnabled && site.allowProjectLatexmkrc !== false} onChange={(event) => setRcEnabled(event.target.checked)} /><span>{t("projectSettings.enableLatexmkrc")}</span></label>
        <p className="field-hint">{t("projectSettings.latexmkrcSource", { path: selectedRcPath })}</p>
        {site.allowProjectLatexmkrc === false ? <p className="field-hint">{t("projectSettings.latexmkrcUnavailable")}</p> : <p className="field-hint latexmkrc-warning"><AlertTriangle size={14} aria-hidden="true" /><span>{t("projectSettings.latexmkrcWarning")}</span></p>}
      </div>}
      <div className="settings-actions">{canManage && <button className="settings-save" disabled={savingCompiler} aria-busy={savingCompiler} onClick={() => void saveCompilerSettings()}>{savingCompiler ? <LoaderCircle className="spin" size={15} /> : <Save size={15} />}{t("projectSettings.saveCompiler")}</button>}</div>
    </section>}
  </div></>;
}
