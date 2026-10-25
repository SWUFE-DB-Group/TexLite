import { useMemo } from "react";
import { useDefaultLayout, type Layout, type LayoutStorage } from "react-resizable-panels";
import { scopedStorageKey } from "../basePath";

function validLayout(value: unknown, panelIds: readonly string[]): value is Layout {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entries = Object.entries(value);
  return entries.length === panelIds.length
    && entries.every(([id, size]) => panelIds.includes(id) && typeof size === "number"
      && Number.isFinite(size) && size >= 0 && size <= 100)
    && Math.abs(entries.reduce((sum, [, size]) => sum + size, 0) - 100) < 0.1;
}

/** Read only current per-combination layouts; invalid/missing records use defaults. */
export function createWorkspacePanelStorage(
  id: string,
  panelIds: readonly string[],
  getStorage: () => LayoutStorage = () => window.localStorage
): LayoutStorage {
  const key = `react-resizable-panels:${id}:${panelIds.join(":")}`;
  return {
    getItem(requestedKey) {
      // Restrict the upstream storage adapter to current-format keys too.
      if (requestedKey !== key) return null;
      try {
        const saved = getStorage().getItem(key);
        return saved && validLayout(JSON.parse(saved), panelIds) ? saved : null;
      } catch { return null; }
    },
    setItem(requestedKey, value) {
      if (requestedKey !== key) return;
      try { getStorage().setItem(key, value); }
      catch { /* Resizing still works when browser storage is unavailable. */ }
    }
  };
}

export function useWorkspacePanelLayout(showEditor: boolean, showPreview: boolean, showContext: boolean) {
  // Sizes for each panel combination remain independent, including the drawer
  // and editor-only/PDF-only views. Keep ids in their actual visual order.
  const panelIds = useMemo(() => [
    ...(showEditor ? ["files", "source"] : []),
    ...(showPreview ? ["preview"] : []),
    ...(showContext ? ["context"] : [])
  ], [showEditor, showPreview, showContext]);
  const id = scopedStorageKey("texlite-workspace-layout");
  const storage = useMemo(() => createWorkspacePanelStorage(id, panelIds), [id, panelIds]);
  return useDefaultLayout({ id, panelIds, storage });
}
