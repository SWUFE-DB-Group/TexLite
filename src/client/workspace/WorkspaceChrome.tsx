import { useEffect, useState, type CSSProperties } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { useTranslation } from "react-i18next";
import { Check, ChevronDown, Code2, Columns2, FileText, PanelLeft, PanelRight } from "lucide-react";
import { type ActiveSession, type CollaborationStatus } from "../collaboration";
import { UserAvatar } from "../UserAvatar";
import type { WorkspaceLayout } from "./types";
import { useCoarsePointer, usePhoneWorkspace } from "./usePhoneWorkspace";

export function CollaborationPresence({ sessions, status }: { sessions: ActiveSession[]; status: CollaborationStatus }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const overflowCount = Math.max(0, sessions.length - 5);
  const showAll = expanded && overflowCount > 0;
  const visibleSessions = showAll ? sessions : sessions.slice(0, 5);
  useEffect(() => {
    if (sessions.length <= 5) setExpanded(false);
  }, [sessions.length]);
  if (sessions.length <= 1) return null;
  return <div className={`collaboration-presence collaboration-${status}`}>
    <span className="collaboration-status-dot" data-tooltip={t(`editor.collaboration.${status}`)} aria-label={t(`editor.collaboration.${status}`)} />
    <div className="collaboration-avatars" aria-label={t("editor.collaboration.activeSessions", { count: sessions.length })}>
      {visibleSessions.map((session) => {
        const activity = session.editing ? t("editor.collaboration.editing") : t("editor.collaboration.viewing");
        const permission = session.permission === "read" ? t("common.readOnly") : t("common.readWrite");
        const title = t("editor.collaboration.sessionTooltip", {
          name: session.name, username: session.username, file: session.filePath || t("editor.collaboration.joining"), activity, permission
        });
        return <span
          className={`collaboration-avatar${session.editing ? " editing" : ""}${session.local ? " local" : ""}`}
          style={{ "--session-color": session.color } as CSSProperties}
          aria-label={title}
          tabIndex={0}
          key={session.clientId}
        ><UserAvatar userId={session.userId} name={session.name} username={session.username} avatarStyle={session.avatarStyle} className="collaboration-avatar-face" /><span className="collaboration-avatar-tooltip" role="tooltip"><strong>{session.name}</strong><span>@{session.username}</span><small>{session.filePath || t("editor.collaboration.joining")} · {activity} · {permission}</small></span></span>;
      })}
      {overflowCount > 0 && <button
        type="button"
        className="collaboration-avatar collaboration-avatar-overflow"
        aria-expanded={showAll}
        aria-label={showAll ? t("editor.collaboration.showFewerSessions") : t("editor.collaboration.showMoreSessions", { count: overflowCount })}
        title={showAll ? t("editor.collaboration.showFewerSessions") : t("editor.collaboration.showMoreSessions", { count: overflowCount })}
        onClick={() => setExpanded((current) => !current)}
      >{showAll ? "−" : `+${overflowCount}`}</button>}
    </div>
  </div>;
}

export function WorkspaceLayoutMenu({ value, onChange, previewLabel = "PDF" }: { value: WorkspaceLayout; onChange: (value: WorkspaceLayout) => void; workspacePrimary?: boolean;
  /** Name of the phone's preview view, e.g. for a Markdown file. */
  previewLabel?: string }) {
  const { t } = useTranslation();
  const phone = usePhoneWorkspace();
  const coarsePointer = useCoarsePointer();
  const layouts = [
    { value: "editor-pdf" as const, icon: Columns2 },
    // Lucide names the narrow side; the wider pane is the one we keep.
    { value: "editor-only" as const, icon: PanelRight },
    { value: "pdf-only" as const, icon: PanelLeft }
  ];
  if (phone) return <div className="workspace-phone-views" role="group" aria-label={t("editor.layout.label")}>
    <button type="button" aria-pressed={value !== "pdf-only"} onClick={() => onChange("editor-only")}><Code2 size={15} /><span>{t("editor.mobileSource")}</span></button>
    <button type="button" aria-pressed={value === "pdf-only"} onClick={() => onChange("pdf-only")}><FileText size={15} /><span>{previewLabel}</span></button>
  </div>;
  if (coarsePointer) {
    const LayoutIcon = layouts.find((layout) => layout.value === value)!.icon;
    const currentLabel = t("editor.layout.current", { layout: t(`editor.layout.${value}.name`) });
    return <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger asChild>
        <button type="button" className="layout-trigger" aria-label={currentLabel} title={currentLabel}>
          <LayoutIcon size={15} aria-hidden="true" />
          <span className="workspace-action-label">
            <small>{t("editor.layout.label")}</small>
            <span className="layout-current-label">{t(`editor.layout.${value}.name`)}</span>
          </span>
          <ChevronDown className="layout-trigger-chevron" size={13} aria-hidden="true" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="layout-popover" align="end" sideOffset={8} collisionPadding={8} aria-label={t("editor.layout.label")}>
          <DropdownMenu.Label className="layout-popover-title">{t("editor.layout.choose")}</DropdownMenu.Label>
          <DropdownMenu.RadioGroup value={value} onValueChange={(next) => onChange(next as WorkspaceLayout)}>
            {layouts.map((layout) => {
              const Icon = layout.icon;
              const selected = layout.value === value;
              return <DropdownMenu.RadioItem
                key={layout.value}
                value={layout.value}
                textValue={t(`editor.layout.${layout.value}.name`)}
                className={`layout-option${selected ? " selected" : ""}`}
              >
                <Icon size={19} aria-hidden="true" />
                <span>
                  <strong>{t(`editor.layout.${layout.value}.name`)}</strong>
                  <small>{t(`editor.layout.${layout.value}.description`)}</small>
                </span>
                {selected && <Check size={16} aria-hidden="true" />}
              </DropdownMenu.RadioItem>;
            })}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>;
  }
  return <div className="layout-segmented" role="group" aria-label={t("editor.layout.label")}>
    {layouts.map((layout) => {
      const Icon = layout.icon;
      const selected = layout.value === value;
      const name = t(`editor.layout.${layout.value}.name`);
      return <button type="button" key={layout.value} className={`layout-segment${selected ? " active" : ""}`}
        aria-pressed={selected} aria-label={name} title={name} onClick={() => onChange(layout.value)}>
        <Icon size={15} aria-hidden="true" />
      </button>;
    })}
  </div>;
}
