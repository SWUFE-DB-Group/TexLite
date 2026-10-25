import { beforeEach, describe, expect, it } from "vitest";
import { defaultEditorPreferences, defaultTexFmtConfig, loadEditorPreferences, saveEditorPreferences } from "../src/client/editorPreferences";

class MemoryStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  clear(): void {
    this.values.clear();
  }
}

const storage = new MemoryStorage();
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });

describe("editor preference scope", () => {
  beforeEach(() => storage.clear());

  it("keeps preferences isolated by user and project", () => {
    const aliceProjectOne = { ...defaultEditorPreferences, fontSize: 20, vimMode: true, formatOnCompile: true, openFilesInTabs: true, showTooltips: true };
    const bobProjectOne = { ...defaultEditorPreferences, fontSize: 12 };
    saveEditorPreferences("alice", "project-one", aliceProjectOne);
    saveEditorPreferences("bob", "project-one", bobProjectOne);

    expect(loadEditorPreferences("alice", "project-one")).toEqual(aliceProjectOne);
    expect(loadEditorPreferences("bob", "project-one")).toEqual(bobProjectOne);
    expect(loadEditorPreferences("alice", "project-two")).toEqual(defaultEditorPreferences);
  });

  it("uses defaults for missing preferences without losing valid saved values", () => {
    storage.setItem("texlite-editor-preferences:alice:paper", JSON.stringify({ fontSize: 18 }));
    expect(loadEditorPreferences("alice", "paper")).toEqual({ ...defaultEditorPreferences, fontSize: 18 });
  });

  it("does not bind an obsolete theme value to a user or project", () => {
    storage.setItem("texlite-editor-preferences:alice:paper", JSON.stringify({ theme: "dark", fontSize: 18 }));
    const preferences = loadEditorPreferences("alice", "paper");
    expect(preferences.fontSize).toBe(18);
    expect(preferences).not.toHaveProperty("theme");
  });

  it("keeps tex-fmt options scoped to the user and project", () => {
    const preferences = { ...defaultEditorPreferences, texFmtConfig: "wrap = true\nwraplen = 90" };
    saveEditorPreferences("alice", "paper", preferences);
    expect(loadEditorPreferences("alice", "paper").texFmtConfig).toBe(preferences.texFmtConfig);
    expect(loadEditorPreferences("bob", "paper").texFmtConfig).toBe(defaultTexFmtConfig);
  });

  it("treats an empty TOML string as an explicit choice without a migration marker", () => {
    saveEditorPreferences("alice", "paper", { ...defaultEditorPreferences, texFmtConfig: "" });
    expect(loadEditorPreferences("alice", "paper").texFmtConfig).toBe("");
    expect(JSON.parse(storage.getItem("texlite-editor-preferences:alice:paper")!)).not.toHaveProperty("texFmtConfigInitialized");
  });
});
