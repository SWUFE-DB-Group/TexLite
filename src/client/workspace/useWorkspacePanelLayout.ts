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

/** Preserve v2's DOM-order percentages; its record key alone was alphabetized. */
export function createWorkspacePanelStorage(
  id: string,
  panelIds: readonly string[],
  getStorage: () => LayoutStorage = () => window.localStorage
): LayoutStorage {
  const legacyKey = `react-resizable-panels:${id}`;
  const key = `${legacyKey}:${panelIds.join(":")}`;
  return {
    getItem(requestedKey) {
      // Handle legacy reads ourselves: the library's generic migration maps
      // array values to the sorted ids, swapping source and preview in v2.
      if (requestedKey !== key) return null;
      try {
        const storage = getStorage();
        const saved = storage.getItem(key);
        if (saved) {
          try {
            if (validLayout(JSON.parse(saved), panelIds)) return saved;
          } catch { /* A damaged preference may fall back to the old record. */ }
        }
        const legacy = JSON.parse(storage.getItem(legacyKey) ?? "null");
        const sizes = legacy?.[[...panelIds].sort().join(",")]?.layout;
        if (!Array.isArray(sizes) || sizes.length !== panelIds.length) return null;
        const layout = Object.fromEntries(panelIds.map((panelId, index) => [panelId, sizes[index]]));
        return validLayout(layout, panelIds) ? JSON.stringify(layout) : null;
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
