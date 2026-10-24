import { useSyncExternalStore } from "react";
import { scopedStorageKey } from "./basePath";
import { editorThemeVariables, type EditorTheme } from "./editorThemes";

export type Theme = EditorTheme;
export type ThemePreference = Theme | "system";
export const themeStorageKey = scopedStorageKey("texlite-theme");
const listeners = new Set<() => void>();
let theme: Theme = "light";
let preference: ThemePreference = "system";
let initialized = false;
let systemQuery: MediaQueryList | null = null;

function savedTheme(): ThemePreference {
  try {
    const value = window.localStorage.getItem(themeStorageKey);
    return value === "light" || value === "dark" ? value : "system";
  } catch {
    return "system";
  }
}

function systemTheme(): Theme {
  try {
    return (systemQuery ?? window.matchMedia?.("(prefers-color-scheme: dark)"))?.matches ? "dark" : "light";
  } catch { return "light"; }
}

function applyPreference(value: ThemePreference): void {
  preference = value;
  applyTheme(value === "system" ? systemTheme() : value);
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
  try { systemQuery = window.matchMedia?.("(prefers-color-scheme: dark)") ?? null; } catch { /* Optional browser API. */ }
  const onSystemChange = () => {
    if (preference !== "system") return;
    const next = systemTheme();
    if (next === theme) return;
    applyTheme(next);
    for (const listener of listeners) listener();
  };
  // Older Safari uses addListener. The subscription lasts for the app's lifetime.
  if (systemQuery?.addEventListener) systemQuery.addEventListener("change", onSystemChange);
  else systemQuery?.addListener?.(onSystemChange);
  applyPreference(savedTheme());
  window.addEventListener("storage", (event) => {
    if (event.key !== null && event.key !== themeStorageKey) return;
    try { if (event.storageArea !== window.localStorage) return; } catch { return; }
    const next = savedTheme();
    if (next === preference) return;
    applyPreference(next);
    for (const listener of listeners) listener();
  });
}

export function currentTheme(): Theme {
  return theme;
}

export function currentThemePreference(): ThemePreference {
  return preference;
}

export function setTheme(value: ThemePreference): void {
  applyPreference(value);
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

export function useThemePreference(): ThemePreference {
  return useSyncExternalStore(subscribe, currentThemePreference, () => "system");
}
