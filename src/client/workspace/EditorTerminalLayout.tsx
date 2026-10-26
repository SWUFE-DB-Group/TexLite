import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Group, Panel, Separator, usePanelRef } from "react-resizable-panels";
import { useTranslation } from "react-i18next";

export interface TerminalPanelControls {
  maximized: boolean;
  toggleMaximized: () => void;
}

export type TerminalPanelRenderer = (controls: TerminalPanelControls) => ReactNode;

export function EditorTerminalLayout({ children, tabs, terminal }: {
  children: ReactNode;
  tabs?: ReactNode;
  terminal?: TerminalPanelRenderer | null;
}) {
  const { t } = useTranslation();
  const sourcePanel = usePanelRef();
  const [sourceCollapsed, setSourceCollapsed] = useState(false);
  const terminalOpen = Boolean(terminal);
  const wasOpen = useRef(terminalOpen);
  const maximized = terminalOpen && sourceCollapsed;
  useLayoutEffect(() => {
    // Clear a collapsed requested size when the terminal is removed, otherwise
    // adding it again can resurrect the previous maximized layout.
    if (wasOpen.current && !terminalOpen) sourcePanel.current?.resize("100%");
    wasOpen.current = terminalOpen;
  }, [sourcePanel, terminalOpen]);
  const toggleMaximized = () => {
    const panel = sourcePanel.current;
    if (panel?.isCollapsed()) panel.expand();
    else panel?.collapse();
  };
  return <main className="source-panel">
    <Group orientation="vertical" className="agent-editor-group">
      <Panel id="source-editor" panelRef={sourcePanel} minSize="20%" collapsible={Boolean(terminal)} collapsedSize="0%"
        onResize={(size) => setSourceCollapsed(size.asPercentage === 0)}>
        {/* Keep both subtrees mounted: maximizing must not reset editing state or the PTY connection. */}
        <div className="source-editor-pane" inert={maximized}>{tabs}{children}</div>
      </Panel>
      {terminal && <><Separator className="agent-terminal-resizer" aria-label={t("agents.resizeTerminal")} />
        <Panel id="agent-terminal" defaultSize="35%" minSize="20%">{terminal({ maximized, toggleMaximized })}</Panel>
      </>}
    </Group>
  </main>;
}
