import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { Check, ChevronDown, Columns2, PanelLeft, PanelRight } from "lucide-react";
import { avatarInitial, type ActiveSession, type CollaborationStatus } from "../collaboration";
import type { WorkspaceLayout } from "./types";

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
  return <div className={`collaboration-presence collaboration-${status}`} title={t(`editor.collaboration.${status}`)}>
    <span className="collaboration-status-dot" aria-label={t(`editor.collaboration.${status}`)} />
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
          title={title}
          aria-label={title}
          tabIndex={0}
          key={session.clientId}
        >{avatarInitial(session.name, session.username)}<span className="collaboration-avatar-tooltip" role="tooltip"><strong>{session.name}</strong><span>@{session.username}</span><small>{session.filePath || t("editor.collaboration.joining")} · {activity} · {permission}</small></span></span>;
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

export function WorkspaceLayoutMenu({ value, onChange }: { value: WorkspaceLayout; onChange: (value: WorkspaceLayout) => void }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const layouts = [
    { value: "editor-pdf" as const, icon: Columns2 },
    { value: "editor-only" as const, icon: PanelLeft },
    { value: "pdf-only" as const, icon: PanelRight }
  ];
  useEffect(() => {
    if (!open) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);
  return <div className="layout-menu" ref={root}>
    <button type="button" className={`layout-trigger${open ? " active" : ""}`} aria-haspopup="menu" aria-expanded={open} title={t("editor.layout.current", { layout: t(`editor.layout.${value}.name`) })} onClick={() => setOpen((current) => !current)}>
      <Columns2 size={15} /><span><small>{t("editor.layout.label")}</small>{t(`editor.layout.${value}.name`)}</span><ChevronDown size={13} />
    </button>
    {open && <div className="layout-popover" role="menu" aria-label={t("editor.layout.label")}>
      <div className="layout-popover-title">{t("editor.layout.choose")}</div>
      {layouts.map((layout) => {
        const Icon = layout.icon;
        const selected = layout.value === value;
        return <button type="button" role="menuitemradio" aria-checked={selected} className={`layout-option${selected ? " selected" : ""}`} key={layout.value} onClick={() => { onChange(layout.value); setOpen(false); }}>
          <Icon size={19} /><span><strong>{t(`editor.layout.${layout.value}.name`)}</strong><small>{t(`editor.layout.${layout.value}.description`)}</small></span>{selected && <Check size={16} />}
        </button>;
      })}
    </div>}
  </div>;
}
