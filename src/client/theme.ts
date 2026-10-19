import { useSyncExternalStore } from "react";
import { scopedStorageKey } from "./basePath";
import { editorThemeVariables, type EditorTheme } from "./editorThemes";

export type Theme = EditorTheme;
export const themeStorageKey = scopedStorageKey("texlite-theme");
const listeners = new Set<() => void>();
let theme: Theme = "light";
let initialized = false;

function savedTheme(): Theme {
  try {
    return window.localStorage.getItem(themeStorageKey) === "dark" ? "dark" : "light";
  } catch {
    return "light";
  }
}

function applyTheme(value: Theme): void {
  theme = value;
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.dataset.theme = value;
  root.style.colorScheme = value;
  for (const [property, color] of Object.entries(editorThemeVariables(value))) root.style.setProperty(property, color);
}

/** Call once before mounting React. No user, project or server state is involved. */
export function initializeTheme(): void {
  if (initialized || typeof window === "undefined") return;
  initialized = true;
  applyTheme(savedTheme());
  window.addEventListener("storage", (event) => {
    if (event.key !== null && event.key !== themeStorageKey) return;
    try { if (event.storageArea !== window.localStorage) return; } catch { return; }
    const next = savedTheme();
    if (next === theme) return;
    applyTheme(next);
    for (const listener of listeners) listener();
  });
}

export function currentTheme(): Theme {
  return theme;
}

export function setTheme(value: Theme): void {
  applyTheme(value);
  try { window.localStorage.setItem(themeStorageKey, value); } catch { /* Browser storage can be disabled. */ }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, currentTheme, () => "light");
}
