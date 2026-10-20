import fs from "node:fs";
import vm from "node:vm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { editorThemeVariables } from "../src/client/editorThemes";

describe("browser-wide theme", () => {
  let storage: Map<string, string>;
  let root: { dataset: Record<string, string>; style: { colorScheme: string; setProperty: ReturnType<typeof vi.fn> } };
  let storageListener: (event: { key: string | null; storageArea: unknown }) => void;
  let localStorage: { getItem: (key: string) => string | null; setItem: (key: string, value: string) => void };

  beforeEach(() => {
    vi.resetModules();
    storage = new Map();
    localStorage = { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => { storage.set(key, value); } };
    root = { dataset: {}, style: { colorScheme: "", setProperty: vi.fn() } };
    vi.stubGlobal("document", { documentElement: root, querySelector: () => ({ content: "/" }) });
    vi.stubGlobal("window", { localStorage, addEventListener: vi.fn((name, listener) => { if (name === "storage") storageListener = listener; }) });
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it.each([undefined, "unknown", "light", "dark"])("initializes %s without any user/project state", async (saved) => {
    if (saved) storage.set("texlite-theme", saved);
    const store = await import("../src/client/theme");
    store.initializeTheme();
    const expected = saved === "dark" ? "dark" : "light";
    expect(store.currentTheme()).toBe(expected);
    expect(root.dataset.theme).toBe(expected);
    expect(root.style.colorScheme).toBe(expected);
    for (const [key, value] of Object.entries(editorThemeVariables(expected))) expect(root.style.setProperty).toHaveBeenCalledWith(key, value);
    expect(storage.size).toBe(saved ? 1 : 0); // Loading does not write defaults.
  });

  it("persists one browser preference and restores it after reloading", async () => {
    const store = await import("../src/client/theme");
    store.initializeTheme();
    store.setTheme("dark");
    expect([...storage]).toEqual([["texlite-theme", "dark"]]);
    expect(root.dataset.theme).toBe("dark");
    vi.resetModules();
    const reloaded = await import("../src/client/theme");
    reloaded.initializeTheme();
    expect(reloaded.currentTheme()).toBe("dark");
    reloaded.setTheme("light");
    expect(root.dataset.theme).toBe("light");
    expect(root.style.setProperty).toHaveBeenCalledWith("--tl-editor-bg", "#FFFFFF");
  });

  it("still switches for this page when browser storage is blocked", async () => {
    vi.stubGlobal("window", { get localStorage() { throw new Error("Blocked"); }, addEventListener: vi.fn() });
    const store = await import("../src/client/theme");
    expect(() => store.initializeTheme()).not.toThrow();
    expect(() => store.setTheme("dark")).not.toThrow();
    expect(store.currentTheme()).toBe("dark");
    expect(root.dataset.theme).toBe("dark");
  });

  it("follows changes and clear events in other tabs, ignoring unrelated storage", async () => {
    const store = await import("../src/client/theme");
    store.initializeTheme();
    store.initializeTheme();
    expect(window.addEventListener).toHaveBeenCalledTimes(1);
    storage.set("texlite-theme", "dark");
    storageListener({ key: "unrelated", storageArea: localStorage });
    expect(store.currentTheme()).toBe("light");
    storageListener({ key: "texlite-theme", storageArea: {} });
    expect(store.currentTheme()).toBe("light");
    storageListener({ key: "texlite-theme", storageArea: localStorage });
    expect(store.currentTheme()).toBe("dark");
    storage.clear();
    storageListener({ key: null, storageArea: localStorage });
    expect(store.currentTheme()).toBe("light");
  });

  it("isolates deployments on the same origin, not users or projects", async () => {
    vi.stubGlobal("document", { documentElement: root, querySelector: () => ({ content: "/tools/texlite" }) });
    const store = await import("../src/client/theme");
    expect(store.themeStorageKey).toBe("texlite-theme:base=%2Ftools%2Ftexlite");
    store.initializeTheme();
    store.setTheme("dark");
    expect([...storage]).toEqual([[store.themeStorageKey, "dark"]]);
  });

  it("resolves system mode immediately, follows OS changes, and ignores them for explicit themes", async () => {
    const query = { matches: true, addEventListener: vi.fn() };
    vi.stubGlobal("window", { localStorage, addEventListener: vi.fn(), matchMedia: vi.fn(() => query) });
    storage.set("texlite-theme", "system");
    const store = await import("../src/client/theme");
    store.initializeTheme();
    store.initializeTheme();
    expect(query.addEventListener).toHaveBeenCalledTimes(1);
    expect(store.currentThemePreference()).toBe("system");
    expect(store.currentTheme()).toBe("dark");
    const onChange = query.addEventListener.mock.calls[0][1] as () => void;
    query.matches = false;
    onChange();
    expect(store.currentTheme()).toBe("light");
    expect(store.currentThemePreference()).toBe("system");
    expect(storage.get("texlite-theme")).toBe("system");
    store.setTheme("dark");
    onChange();
    expect(store.currentTheme()).toBe("dark");
    store.setTheme("system");
    expect(store.currentTheme()).toBe("light");
    expect(root.style.setProperty).toHaveBeenCalledWith("--tl-editor-bg", "#FFFFFF");
  });

  it("synchronizes the selected mode across tabs even when the resolved color is unchanged", async () => {
    const query = { matches: false, addEventListener: vi.fn() };
    vi.stubGlobal("window", { localStorage, matchMedia: () => query, addEventListener: vi.fn((name, listener) => { if (name === "storage") storageListener = listener; }) });
    const store = await import("../src/client/theme");
    store.initializeTheme();
    storage.set("texlite-theme", "system");
    storageListener({ key: "texlite-theme", storageArea: localStorage });
    expect(store.currentTheme()).toBe("light");
    expect(store.currentThemePreference()).toBe("system");
    query.matches = true;
    (query.addEventListener.mock.calls[0][1] as () => void)();
    expect(store.currentTheme()).toBe("dark");
    storage.clear();
    storageListener({ key: null, storageArea: localStorage });
    expect(store.currentThemePreference()).toBe("light");
    expect(store.currentTheme()).toBe("light");
  });

  it("supports Safari's older MediaQueryList listener API", async () => {
    const query = { matches: false, addListener: vi.fn() };
    vi.stubGlobal("window", { localStorage, addEventListener: vi.fn(), matchMedia: () => query });
    const store = await import("../src/client/theme");
    store.initializeTheme();
    store.setTheme("system");
    query.matches = true;
    (query.addListener.mock.calls[0][0] as () => void)();
    expect(store.currentTheme()).toBe("dark");
  });

  it("retains system mode when media queries or storage are unavailable", async () => {
    vi.stubGlobal("window", { get localStorage() { throw new Error("Blocked"); }, addEventListener: vi.fn() });
    const store = await import("../src/client/theme");
    store.initializeTheme();
    store.setTheme("system");
    expect(store.currentThemePreference()).toBe("system");
    expect(store.currentTheme()).toBe("light");
  });
});

describe("theme before first paint", () => {
  const html = fs.readFileSync(new URL("../src/client/index.html", import.meta.url), "utf8");
  const bootstrap = html.match(/<script>([\s\S]*?)<\/script>/)![1];

  it.each(["/", "/tools/texlite"])("uses the same browser key as the application at %s", async (base) => {
    const { scopedStorageKey } = await import("../src/client/basePath");
    const getItem = vi.fn((key: string) => key === scopedStorageKey("texlite-theme", base) ? "dark" : null);
    const root = { dataset: { theme: "" }, style: { colorScheme: "" } };
    vm.runInNewContext(bootstrap, { document: { querySelector: () => ({ content: base }), documentElement: root }, localStorage: { getItem } });
    expect(root.dataset.theme).toBe("dark");
    expect(root.style.colorScheme).toBe("dark");
    expect(getItem).toHaveBeenCalledWith(scopedStorageKey("texlite-theme", base));
    expect(html.indexOf("<script>")).toBeLessThan(html.indexOf('rel="stylesheet"'));
  });

  it("falls back to light if storage is unavailable before React starts", () => {
    const root = { dataset: { theme: "" }, style: { colorScheme: "" } };
    vm.runInNewContext(bootstrap, { document: { documentElement: root, querySelector: () => ({ content: "/" }) }, localStorage: { getItem() { throw new Error("Blocked"); } } });
    expect(root.dataset.theme).toBe("light");
    expect(root.style.colorScheme).toBe("light");
  });

  it.each([false, true])("resolves saved system mode before first paint (dark=%s)", (matches) => {
    const root = { dataset: { theme: "" }, style: { colorScheme: "" } };
    vm.runInNewContext(bootstrap, { document: { documentElement: root, querySelector: () => ({ content: "/" }) },
      localStorage: { getItem: () => "system" }, matchMedia: () => ({ matches }) });
    expect(root.dataset.theme).toBe(matches ? "dark" : "light");
    expect(root.style.colorScheme).toBe(root.dataset.theme);
  });

  it("uses light for saved system mode when matchMedia is unavailable", () => {
    const root = { dataset: { theme: "" }, style: { colorScheme: "" } };
    vm.runInNewContext(bootstrap, { document: { documentElement: root, querySelector: () => ({ content: "/" }) }, localStorage: { getItem: () => "system" } });
    expect(root.dataset.theme).toBe("light");
  });
});
