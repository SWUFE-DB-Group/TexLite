import { useSyncExternalStore } from "react";
import { scopedStorageKey } from "./basePath";
import { editorFonts, type EditorFont } from "./editorPreferences";

export interface TerminalPreferences {
  font: EditorFont | "system";
  fontSize: number;
}

export const terminalFonts = [
  ...editorFonts,
  { id: "system" as const, labelKey: "projectSettings.fontSystem", stack: 'ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace' }
];
export const terminalFontSizes = [11, 12, 13, 14, 15, 16, 18, 20];
export const terminalLineHeight = 1.2;
export const defaultTerminalPreferences: TerminalPreferences = { font: "jetbrains", fontSize: 13 };
export const terminalPreferencesStorageKey = scopedStorageKey("texlite-terminal-preferences");

export function terminalFontStack(font: TerminalPreferences["font"]): string {
  return (terminalFonts.find((option) => option.id === font) ?? terminalFonts[0]).stack;
}

function normalize(value: unknown): TerminalPreferences {
  const stored = value && typeof value === "object" ? value as Partial<TerminalPreferences> : {};
  return {
    font: terminalFonts.some((option) => option.id === stored.font) ? stored.font! : defaultTerminalPreferences.font,
    fontSize: terminalFontSizes.includes(stored.fontSize!) ? stored.fontSize! : defaultTerminalPreferences.fontSize
  };
}

function load(): TerminalPreferences {
  try { return normalize(JSON.parse(window.localStorage.getItem(terminalPreferencesStorageKey) ?? "{}")); }
  catch { return { ...defaultTerminalPreferences }; }
}

let current: TerminalPreferences | undefined;
const listeners = new Set<() => void>();
function notify(): void { for (const listener of listeners) listener(); }

export function currentTerminalPreferences(): TerminalPreferences {
  if (!current) {
    current = load();
    // One app-lifetime subscription, like the browser-wide theme preference.
    if (typeof window !== "undefined") window.addEventListener("storage", (event) => {
      if (event.key !== null && event.key !== terminalPreferencesStorageKey) return;
      try { if (event.storageArea !== window.localStorage) return; } catch { return; }
      current = load();
      notify();
    });
  }
  return current;
}

/** Apply immediately, returning whether the choice was durably saved in this browser. */
export function saveTerminalPreferences(value: TerminalPreferences): boolean {
  currentTerminalPreferences();
  current = normalize(value);
  let persisted = false;
  try { window.localStorage.setItem(terminalPreferencesStorageKey, JSON.stringify(current)); persisted = true; }
  catch { /* Keep the current page usable when browser storage is unavailable. */ }
  notify();
  return persisted;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Device/browser preference, independent of editor settings, users and projects. */
export function useTerminalPreferences(): TerminalPreferences {
  return useSyncExternalStore(subscribe, currentTerminalPreferences, () => defaultTerminalPreferences);
}
