import type { ReactNode } from "react";
import { ArrowLeft } from "lucide-react";
import { useTranslation } from "react-i18next";
import { appPath } from "../basePath";
import { SiteLogo } from "../pages/SiteChrome";
import { WorkspaceProjectTitle } from "./WorkspaceProjectTitle";

/** Shared workspace chrome only: no account, collaboration or tool lifecycle. */
export function WorkspaceTopbarFrame({ siteName, projectName, subtitle, onBack, titleAccessory, accessory, children }: {
  siteName: string; projectName: string; subtitle: ReactNode; onBack?: () => void;
  titleAccessory?: ReactNode; accessory?: ReactNode; children: ReactNode;
}) {
  const { t } = useTranslation();
  return <header className="editor-topbar">
    {onBack ? <button className="back" title={t("editor.backToProjects")} aria-label={t("editor.backToProjects")} onClick={onBack}><ArrowLeft size={18} /></button>
      : <a className="back" href={appPath("/")} aria-label={t("editor.backToProjects")}><ArrowLeft size={18} /></a>}
    <a className="brand-link compact-brand-link" href={appPath("/")} aria-label={siteName} onClick={onBack ? (event) => { event.preventDefault(); onBack(); } : undefined}><SiteLogo siteName={siteName} compact /></a>
    <div className="project-heading">
      {titleAccessory ? <div className="workspace-project-title-row"><WorkspaceProjectTitle name={projectName} />{titleAccessory}</div>
        : <WorkspaceProjectTitle name={projectName} />}
      <small>{subtitle}</small>
    </div>
    {accessory}
    <div className="editor-actions">{children}</div>
  </header>;
}
