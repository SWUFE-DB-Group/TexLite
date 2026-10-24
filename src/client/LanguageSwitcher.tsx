import { useTranslation } from "react-i18next";
import { appLocale } from "../shared/locales";

export function LanguageSwitcher() {
  const { i18n, t } = useTranslation();
  const language = appLocale(i18n.resolvedLanguage);
  return <label className="language-switcher" title={t("common.language")}>
    <span>文/A</span>
    <select value={language} aria-label={t("common.language")} onChange={(event) => void i18n.changeLanguage(event.target.value)}>
      <option value="en">{t("common.languageEnglish")}</option><option value="zh">{t("common.languageChinese")}</option><option value="zh-Hant">{t("common.languageTraditionalChinese")}</option>
    </select>
  </label>;
}
