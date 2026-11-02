import { useMemo, type ReactNode } from "react";
import { Group, Panel, Separator, useDefaultLayout } from "react-resizable-panels";
import { useTranslation } from "react-i18next";
import { scopedStorageKey } from "../basePath";
import { createWorkspacePanelStorage } from "./useWorkspacePanelLayout";

const panelIds = ["file-tree", "file-outline"];

/** Resize content regions without scaling their toolbars or rebuilding either tree. */
export function WorkspaceSidebarLayout({ files, outline, phone = false }: {
  files: ReactNode; outline: ReactNode; phone?: boolean;
}) {
  const { t } = useTranslation();
  const id = scopedStorageKey(`texlite-file-outline-layout${phone ? ":phone" : ""}`);
  const storage = useMemo(() => createWorkspacePanelStorage(id, panelIds), [id]);
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({ id, panelIds, storage, onlySaveAfterUserInteractions: true });
  return <aside className="left-panel">
    <Group orientation="vertical" className="file-outline-layout" defaultLayout={defaultLayout} onLayoutChanged={onLayoutChanged}
      resizeTargetMinimumSize={{ fine: 8, coarse: 20 }}>
      <Panel id="file-tree" defaultSize="60%" minSize="120px">{files}</Panel>
      <Separator className="file-outline-resizer" aria-label={t("editor.resizeFileOutline")} title={t("editor.resizeFileOutline")}><span aria-hidden="true" /></Separator>
      <Panel id="file-outline" defaultSize="40%" minSize="100px">{outline}</Panel>
    </Group>
  </aside>;
}
