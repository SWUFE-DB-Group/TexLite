import { beforeEach, describe, expect, it } from "vitest";
import { defaultEditorPreferences, loadEditorPreferences, saveEditorPreferences } from "../src/client/editorPreferences";

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
    const aliceProjectOne = { ...defaultEditorPreferences, fontSize: 20, vimMode: true };
    const bobProjectOne = { ...defaultEditorPreferences, fontSize: 12 };
    saveEditorPreferences("alice", "project-one", aliceProjectOne);
    saveEditorPreferences("bob", "project-one", bobProjectOne);

    expect(loadEditorPreferences("alice", "project-one")).toEqual(aliceProjectOne);
    expect(loadEditorPreferences("bob", "project-one")).toEqual(bobProjectOne);
    expect(loadEditorPreferences("alice", "project-two")).toEqual(defaultEditorPreferences);
  });
});
