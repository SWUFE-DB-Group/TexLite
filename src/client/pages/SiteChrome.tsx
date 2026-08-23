import { version as texliteVersion } from "../../../package.json";
import { useTranslation } from "react-i18next";

export function SiteLogo({ siteName, compact = false, auth = false }: { siteName: string; compact?: boolean; auth?: boolean }) {
  return <span className={`site-logo${compact ? " compact" : ""}${auth ? " auth-logo" : ""}`}>
    <img src="/logo.svg" alt={siteName} />
  </span>;
}
export function SiteFooter() {
  const { t } = useTranslation();
  const repositoryUrl = "https://github.com/SWUFE-DB-Group/TexLite";
  return <footer className="site-footer"><span>{t("footer.copyright", { year: new Date().getFullYear() })} <a href={repositoryUrl} target="_blank" rel="noreferrer">TexLite v{texliteVersion}</a></span><span>{t("footer.credit")}</span></footer>;
}
