import { useTranslation } from "react-i18next";
import { Save, Terminal } from "lucide-react";
import { terminalFonts, terminalFontSizes, terminalLineHeight, terminalFontStack, type TerminalPreferences } from "../terminalPreferences";
import { terminalThemes, terminalThemeStyle } from "../terminalTheme";

export function TerminalAppearanceSettings({ preferences, onChange, onSave }: {
  preferences: TerminalPreferences;
  onChange: (preferences: TerminalPreferences) => void;
  onSave: () => void;
}) {
  const { t } = useTranslation();
  return <section id="settings-panel-terminal" role="tabpanel" aria-labelledby="settings-tab-terminal">
    <div className="settings-section-title"><Terminal size={15} /><strong>{t("projectSettings.terminalTab")}</strong></div>
    <p className="settings-description appearance-description">{t("projectSettings.terminalDescription")}</p>
    <label className="editor-checkbox"><input type="checkbox" checked={preferences.showExecutionReminder} onChange={(event) => onChange({ ...preferences, showExecutionReminder: event.target.checked })} /><span>{t("projectSettings.terminalExecutionReminder")}</span></label>
    <label>{t("projectSettings.terminalTheme")}<select value={preferences.theme} onChange={(event) => onChange({ ...preferences, theme: event.target.value as TerminalPreferences["theme"] })}>
      {Object.entries(terminalThemes).map(([id, theme]) => <option value={id} key={id}>{t(theme.labelKey)}</option>)}
    </select></label>
    <label>{t("projectSettings.terminalFont")}<select value={preferences.font} onChange={(event) => onChange({ ...preferences, font: event.target.value as TerminalPreferences["font"] })}>
      {terminalFonts.map((font) => <option value={font.id} key={font.id}>{t(font.labelKey)}</option>)}
    </select></label>
    <label>{t("projectSettings.fontSize")}<select value={preferences.fontSize} onChange={(event) => onChange({ ...preferences, fontSize: Number(event.target.value) })}>
      {terminalFontSizes.map((size) => <option value={size} key={size}>{size} px</option>)}
    </select></label>
    <pre className="terminal-appearance-preview" aria-label={t("projectSettings.terminalPreview")} style={{ ...terminalThemeStyle(preferences.theme), fontFamily: terminalFontStack(preferences.font), fontSize: preferences.fontSize, lineHeight: terminalLineHeight }}>
      <span className="terminal-preview-directory">~/paper</span><span className="terminal-preview-muted"> on </span><span className="terminal-preview-branch">main</span>{"\n"}
      <span className="terminal-preview-prompt">❯</span>{" codex\nAa Bb  0 O  1 l I\n→ main.tex  [1/2]  ✓"}
    </pre>
    <div className="settings-actions"><button className="settings-save" onClick={onSave}><Save size={15} />{t("projectSettings.saveTerminal")}</button></div>
  </section>;
}
