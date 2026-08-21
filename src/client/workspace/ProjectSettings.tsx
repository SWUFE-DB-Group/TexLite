import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlignLeft, BookOpen, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, PanelsTopLeft, Save, Settings, SpellCheck2, Type, WrapText, X } from "lucide-react";
import { api } from "../api";
import { editorFonts, type EditorPreferences } from "../editorPreferences";
import { errorMessage } from "../errors";
import type { FileEntry, Project, SiteConfig } from "../types";

export function ProjectSettings({ project, projectId, site, files, dictionaryWords, onDictionaryChange, editorPreferences, onEditorPreferences, spellCheckCount, spellCheckUniqueCount, spellCheckIndex, onSpellCheckNavigate, onProject }: {
  project: Project; projectId: string; site: SiteConfig; files: FileEntry[]; dictionaryWords: string[];
  onDictionaryChange: (words: string[]) => void;
  editorPreferences: EditorPreferences; onEditorPreferences: (preferences: EditorPreferences) => void;
  spellCheckCount: number | null; spellCheckUniqueCount: number | null; spellCheckIndex: number;
  onSpellCheckNavigate: (index: number) => void;
  onProject: (project: Project) => void;
}) {
  const { t } = useTranslation();
  const [engine, setEngine] = useState(project.engine);
  const [rcText, setRcText] = useState("");
  const [name, setName] = useState(project.name);
  const [mainFile, setMainFile] = useState(project.mainFile);
  const [error, setError] = useState("");
  const [dictionaryValue, setDictionaryValue] = useState("");
  const [dictionaryError, setDictionaryError] = useState("");
  const [settingsTab, setSettingsTab] = useState<"appearance" | "compiler">("appearance");
  const [appearancePreferences, setAppearancePreferences] = useState(editorPreferences);
  const canManage = project.permission === "owner";
  const canEdit = project.permission !== "read";
  const canManageDictionary = project.permission !== "read";
  useEffect(() => setAppearancePreferences(editorPreferences), [editorPreferences]);
  useEffect(() => {
    if (!project.latexmkrc) return setRcText("");
    void api<{ content: string }>(`/api/projects/${projectId}/file?path=${encodeURIComponent(project.latexmkrc)}`)
      .then(({ content }) => setRcText(content)).catch((requestError) => setError(errorMessage(requestError)));
  }, [project.latexmkrc]);
  const texFiles = files.filter((entry) => entry.type === "file" && /\.tex$/i.test(entry.path)).map((entry) => entry.path);
  const mainFileOptions = [...new Set(project.mainFile && project.mainFile.toLowerCase().endsWith(".tex") ? [...texFiles, project.mainFile] : texFiles)]
    .sort((left, right) => left.localeCompare(right));
  const saveCompilerSettings = async () => {
    try {
      const latexmkrc = rcText.trim() && site.allowProjectLatexmkrc !== false ? ".latexmkrc" : null;
      if (latexmkrc) await api(`/api/projects/${projectId}/file`, { method: "PUT", body: JSON.stringify({ path: latexmkrc, content: rcText }) });
      const result = await api<{ project: Project }>(`/api/projects/${projectId}`, {
        method: "PATCH", body: JSON.stringify({ name, mainFile, engine, latexmkrc })
      });
      onProject(result.project);
    } catch (requestError) { setError(errorMessage(requestError)); }
  };
  const saveAppearanceSettings = () => onEditorPreferences(appearancePreferences);
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
  return <div className="settings padded">
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
        <label className="editor-checkbox"><input type="checkbox" checked={appearancePreferences.spellCheck} onChange={(event) => setAppearancePreferences({ ...appearancePreferences, spellCheck: event.target.checked })} /><span>{t("projectSettings.spellCheck")}</span></label>
        <p className="field-hint">{t("projectSettings.writingCheckDescription")} <a href="https://writewithharper.com/docs/harperjs/introduction" target="_blank" rel="noreferrer">Harper.js</a></p>
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
        <p className="field-hint">{t(canEdit ? "projectSettings.formatOnCompileDescription" : "projectSettings.formatRequiresWrite")} {t("projectSettings.formatterDescription")} <a href="https://github.com/wgunderwood/tex-fmt" target="_blank" rel="noreferrer">{t("projectSettings.formatterInstall")}</a> · <a href="https://github.com/FlamingTempura/bibtex-tidy" target="_blank" rel="noreferrer">{t("projectSettings.bibtexTidyInstall")}</a></p>
      </div>
      {spellCheckCount !== null && <div className={`spell-check-result${spellCheckCount ? " has-issues" : ""}`} role="status" aria-live="polite"><SpellCheck2 size={14} /><span>{spellCheckCount ? t("projectSettings.writingIssues", { count: spellCheckCount, uniqueCount: spellCheckUniqueCount ?? 0 }) : t("projectSettings.noWritingIssues")}</span>{spellCheckCount > 0 && <span className="spell-check-controls"><button type="button" title={t("projectSettings.spellCheckFirst")} aria-label={t("projectSettings.spellCheckFirst")} disabled={spellCheckIndex <= 0} onClick={() => onSpellCheckNavigate(0)}><ChevronsLeft size={14} /></button><button type="button" title={t("projectSettings.spellCheckPrevious")} aria-label={t("projectSettings.spellCheckPrevious")} disabled={spellCheckIndex <= 0} onClick={() => onSpellCheckNavigate(spellCheckIndex - 1)}><ChevronLeft size={14} /></button><span className="spell-check-position">{t("projectSettings.spellCheckPosition", { current: Math.min(spellCheckIndex + 1, spellCheckCount), total: spellCheckCount })}</span><button type="button" title={t("projectSettings.spellCheckNext")} aria-label={t("projectSettings.spellCheckNext")} disabled={spellCheckIndex >= spellCheckCount - 1} onClick={() => onSpellCheckNavigate(spellCheckIndex + 1)}><ChevronRight size={14} /></button><button type="button" title={t("projectSettings.spellCheckLast")} aria-label={t("projectSettings.spellCheckLast")} disabled={spellCheckIndex >= spellCheckCount - 1} onClick={() => onSpellCheckNavigate(spellCheckCount - 1)}><ChevronsRight size={14} /></button></span>}</div>}
      <div className="settings-section-title"><BookOpen size={15} /><strong>{t("projectSettings.dictionary")}</strong></div>
      <p className="settings-description">{t("projectSettings.dictionaryDescription")}</p>
      {dictionaryError && <p className="error dictionary-error">{dictionaryError}</p>}
      {canManageDictionary && <div className="dictionary-add"><input value={dictionaryValue} placeholder={t("projectSettings.dictionaryPlaceholder")} onChange={(event) => setDictionaryValue(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void addDictionaryWord(); } }} /><button type="button" disabled={!dictionaryValue.trim()} onClick={() => void addDictionaryWord()}>{t("projectSettings.addWord")}</button></div>}
      <div className="dictionary-words">{dictionaryWords.map((word) => <span className="dictionary-word" key={word}><code>{word}</code>{canManageDictionary && <button type="button" title={t("common.delete")} aria-label={`${t("common.delete")} ${word}`} onClick={() => void removeDictionaryWord(word)}><X size={13} /></button>}</span>)}{dictionaryWords.length === 0 && <span className="dictionary-empty">{t("projectSettings.dictionaryEmpty")}</span>}</div>
      <div className="settings-actions"><button className="settings-save" onClick={saveAppearanceSettings}><Save size={15} />{t("projectSettings.saveAppearance")}</button></div>
    </section> : <section id="settings-panel-compiler" role="tabpanel" aria-labelledby="settings-tab-compiler">
      <div className="settings-section-title"><Settings size={15} /><strong>{t("projectSettings.compilerTab")}</strong></div>
      <p className="settings-description compiler-description">{t("projectSettings.compilerDescription")}</p>
      <label>{t("projects.name")}<input disabled={!canManage} value={name} onChange={(event) => setName(event.target.value)} /></label>
      <label>{t("projectSettings.mainFile")}<select disabled={!canManage || mainFileOptions.length === 0} value={mainFile} onChange={(event) => setMainFile(event.target.value)}>{mainFileOptions.map((filePath) => <option value={filePath} key={filePath}>{filePath}</option>)}</select></label>
      <label>{t("projectSettings.engine")}<select disabled={!canManage} value={engine} onChange={(event) => setEngine(event.target.value as Project["engine"])}>{(site.allowedEngines ?? ["pdflatex", "xelatex", "lualatex"]).map((item) => <option key={item}>{item}</option>)}</select></label>
      <label>{t("projectSettings.latexmkrc")}<textarea className="latexmkrc-editor" rows={10} spellCheck={false} disabled={!canManage || site.allowProjectLatexmkrc === false} value={rcText} placeholder={t("projectSettings.latexmkrcPlaceholder")} onChange={(event) => setRcText(event.target.value)} /></label>
      <div className="settings-actions">{canManage && <button className="settings-save" onClick={() => void saveCompilerSettings()}><Save size={15} />{t("projectSettings.saveCompiler")}</button>}</div>
    </section>}
  </div>;
}
