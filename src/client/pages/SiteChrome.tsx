import { version as texliteVersion } from "../../../package.json";
import { useTranslation } from "react-i18next";

export function SiteLogo({ siteName, compact = false, auth = false }: { siteName: string; compact?: boolean; auth?: boolean }) {
  return <span className={`site-logo${compact ? " compact" : ""}${auth ? " auth-logo" : ""}`}>
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label={siteName}>
      <rect width="64" height="64" rx="15" fill="#E9F5EE" />
      <g fill="none" strokeWidth="6" strokeLinecap="round" strokeLinejoin="round">
        <path stroke="#133D2B" d="M13.5 16.5H31.5M22.5 16.5V41.5" />
        <path stroke="#1B8A57" d="M42.5 23.5V48.5M42.5 23.5H50.5M42.5 36H48.5M42.5 48.5H50.5" />
      </g>
    </svg>
  </span>;
}
export function SiteFooter() {
  const { t } = useTranslation();
  const repositoryUrl = "https://github.com/SWUFE-DB-Group/TexLite";
  return <footer className="site-footer"><span className="site-footer-tagline">{t("footer.tagline")}</span><span>{t("footer.copyright", { year: new Date().getFullYear() })} <a href={repositoryUrl} target="_blank" rel="noreferrer">TexLite v{texliteVersion}</a></span></footer>;
}
