import { Children, cloneElement, isValidElement, useState, type MouseEventHandler, type ReactNode } from "react";
import * as Popover from "@radix-ui/react-popover";
import { Ellipsis } from "lucide-react";
import { useTranslation } from "react-i18next";
import { appPath } from "../basePath";
import { SiteLogo } from "../pages/SiteChrome";
import { WorkspaceProjectTitle } from "./WorkspaceProjectTitle";
import { usePhoneWorkspace, usePhoneWorkspaceHeight } from "./usePhoneWorkspace";

/** Shared workspace chrome only: no account, collaboration or tool lifecycle. */
export function WorkspaceTopbarFrame({ siteName, projectName, subtitle, onBack, leading, titleAccessory, accessory, children }: {
  siteName: string; projectName: string; subtitle: ReactNode; onBack?: () => void;
  /** Shown at the far left, before the logo, at every width. */
  leading?: ReactNode;
  titleAccessory?: ReactNode; accessory?: ReactNode; children: ReactNode;
}) {
  const { t } = useTranslation();
  const phone = usePhoneWorkspace();
  usePhoneWorkspaceHeight(phone);
  const [moreOpen, setMoreOpen] = useState(false);
  const actions = Children.toArray(children);
  const primary = (node: ReactNode) => isValidElement<{ className?: string; workspacePrimary?: boolean }>(node)
    && (node.props.workspacePrimary || /(?:^| )(?:compile|comments-action|files-action)(?: |$)/.test(node.props.className ?? ""));
  return <header className="editor-topbar">
    <div className="editor-topbar-start">
      {leading && <div className="editor-actions editor-leading-actions">{leading}</div>}
      {/* The logo is the way back to the project list at every width. */}
      <a className="brand-link compact-brand-link" href={appPath("/")} title={t("editor.backToProjects")} aria-label={`${siteName}: ${t("editor.backToProjects")}`}
        onClick={onBack ? (event) => { event.preventDefault(); onBack(); } : undefined}><SiteLogo siteName={siteName} compact /></a>
    </div>
    <div className="project-heading">
      {titleAccessory ? <div className="workspace-project-title-row"><WorkspaceProjectTitle name={projectName} />{titleAccessory}</div>
        : <WorkspaceProjectTitle name={projectName} />}
      <small>{subtitle}</small>
    </div>
    <div className="workspace-header-accessory">{accessory}</div>
    {phone && <Popover.Root open={moreOpen} onOpenChange={setMoreOpen}>
      <Popover.Trigger asChild><button type="button" className="workspace-more-trigger" aria-label={t("editor.moreActions")}><Ellipsis size={21} /></button></Popover.Trigger>
      <Popover.Portal><Popover.Content className="workspace-overflow-menu" align="end" sideOffset={8} collisionPadding={10} aria-label={t("editor.moreActions")}>
        {actions.filter((node) => !primary(node)).map((node) => {
          if (!isValidElement<{ onClick?: MouseEventHandler<HTMLButtonElement> }>(node) || node.type !== "button") return node;
          return cloneElement(node, { onClick: (event) => { node.props.onClick?.(event); setMoreOpen(false); } });
        })}
      </Popover.Content></Popover.Portal>
    </Popover.Root>}
    <div className="editor-actions">{phone ? actions.filter(primary) : children}</div>
  </header>;
}
