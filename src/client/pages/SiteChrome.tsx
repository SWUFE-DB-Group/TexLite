import { version as texliteVersion } from "../../../package.json";
import { useTranslation } from "react-i18next";
import { appPath } from "../basePath";

export function SiteLogo({ siteName, compact = false, auth = false }: { siteName: string; compact?: boolean; auth?: boolean }) {
  const useTexMark = !auth;
  return <span className={`site-logo${compact ? " compact" : ""}${auth ? " auth-logo" : ""}${useTexMark ? " tex-mark" : ""}`}>
    {useTexMark ? <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 83 43" role="img" aria-label={siteName}>
      <g fill="none" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round">
        <g stroke="#E9F5EE">
          <path d="M4.5 6H25.5M15 6V31" />
          <path d="M59 6L78 31M78 6L59 31" />
        </g>
        <path stroke="#7DDBA3" d="M35.5 12V37M35.5 12H49.5M35.5 24.5H46.5M35.5 37H49.5" />
      </g>
    </svg> : <img src={appPath("/logo.svg")} alt={siteName} />}
  </span>;
}
export function SiteFooter() {
  const { t } = useTranslation();
  const repositoryUrl = "https://github.com/SWUFE-DB-Group/TexLite";
  return <footer className="site-footer"><span className="site-footer-tagline">{t("footer.tagline")}</span><span>{t("footer.copyright", { year: new Date().getFullYear() })} <a href={repositoryUrl} target="_blank" rel="noreferrer">TexLite v{texliteVersion}</a></span></footer>;
}
