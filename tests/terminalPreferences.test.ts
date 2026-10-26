import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("browser-wide terminal preferences", () => {
  let values: Map<string, string>;
  let storage: { getItem: (key: string) => string | null; setItem: (key: string, value: string) => void };
  let onStorage: (event: { key: string | null; storageArea: unknown }) => void;

  beforeEach(() => {
    vi.resetModules();
    values = new Map();
    storage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); } };
    vi.stubGlobal("window", { localStorage: storage, addEventListener: (name: string, callback: typeof onStorage) => { if (name === "storage") onStorage = callback; } });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("uses legible defaults without writing them into browser storage", async () => {
    const store = await import("../src/client/terminalPreferences");
    expect(store.currentTerminalPreferences()).toEqual({ font: "jetbrains", fontSize: 13, lineHeight: 1.2 });
    expect(store.currentTerminalPreferences()).toBe(store.currentTerminalPreferences());
    expect(values.size).toBe(0);
  });

  it("persists independently of editor/user/project settings and restores after reload", async () => {
    values.set("texlite-editor-preferences:alice:paper", '{"font":"iosevka","fontSize":20}');
    const store = await import("../src/client/terminalPreferences");
    const selected = { font: "ibm-plex", fontSize: 15, lineHeight: 1.4 } as const;
    store.saveTerminalPreferences(selected);
    expect(store.currentTerminalPreferences()).toEqual(selected);
    expect(values.get("texlite-editor-preferences:alice:paper")).toBe('{"font":"iosevka","fontSize":20}');
    vi.resetModules();
    const reloaded = await import("../src/client/terminalPreferences");
    expect(reloaded.currentTerminalPreferences()).toEqual(selected);
  });

  it.each(["not-json", "null", "[]", '{"font":"unknown","fontSize":999,"lineHeight":0}', '{"fontSize":"15","lineHeight":"1.2"}'])(
    "safely defaults malformed or unsupported settings (%s)", async (raw) => {
      values.set("texlite-terminal-preferences", raw);
      const store = await import("../src/client/terminalPreferences");
      expect(store.currentTerminalPreferences()).toEqual(store.defaultTerminalPreferences);
    }
  );

  it("keeps valid partial settings and offers a system-font fallback", async () => {
    values.set("texlite-terminal-preferences", '{"font":"system","fontSize":16}');
    const store = await import("../src/client/terminalPreferences");
    expect(store.currentTerminalPreferences()).toEqual({ font: "system", fontSize: 16, lineHeight: 1.2 });
    expect(store.terminalFontStack("system")).toContain("monospace");
    expect(store.terminalFonts).toHaveLength(6);
  });

  it("accepts cross-tab updates and resets on storage clear but ignores unrelated storage", async () => {
    const store = await import("../src/client/terminalPreferences");
    store.currentTerminalPreferences();
    values.set(store.terminalPreferencesStorageKey, '{"font":"iosevka","fontSize":14}');
    onStorage({ key: store.terminalPreferencesStorageKey, storageArea: {} });
    expect(store.currentTerminalPreferences().font).toBe("jetbrains");
    onStorage({ key: store.terminalPreferencesStorageKey, storageArea: storage });
    expect(store.currentTerminalPreferences().font).toBe("iosevka");
    values.clear();
    onStorage({ key: null, storageArea: storage });
    expect(store.currentTerminalPreferences()).toEqual(store.defaultTerminalPreferences);
  });

  it("retains in-memory choices when browser storage is disabled", async () => {
    storage.getItem = () => { throw new Error("Storage disabled"); };
    storage.setItem = () => { throw new Error("Storage disabled"); };
    const store = await import("../src/client/terminalPreferences");
    expect(store.saveTerminalPreferences({ font: "source-code", fontSize: 18, lineHeight: 1 })).toBe(false);
    expect(store.currentTerminalPreferences()).toEqual({ font: "source-code", fontSize: 18, lineHeight: 1 });
  });

  it("isolates separate deployments on the same origin", async () => {
    vi.stubGlobal("document", { querySelector: () => ({ content: "/tools/texlite" }) });
    const store = await import("../src/client/terminalPreferences");
    store.saveTerminalPreferences(store.defaultTerminalPreferences);
    expect([...values.keys()]).toEqual(["texlite-terminal-preferences:base=%2Ftools%2Ftexlite"]);
  });
});
