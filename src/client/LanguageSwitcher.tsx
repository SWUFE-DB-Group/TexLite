import { useTranslation } from "react-i18next";

export function LanguageSwitcher({ compact = false }: { compact?: boolean }) {
  const { i18n, t } = useTranslation();
  const language = i18n.resolvedLanguage?.startsWith("zh") ? "zh" : "en";
  return <label className={`language-switcher${compact ? " compact" : ""}`} title={t("common.language")}>
    <span>文/A</span>
    <select value={language} aria-label={t("common.language")} onChange={(event) => void i18n.changeLanguage(event.target.value)}>
      <option value="en">{t("common.languageEnglish")}</option><option value="zh">{t("common.languageChinese")}</option>
    </select>
  </label>;
}
