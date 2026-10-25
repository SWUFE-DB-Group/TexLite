import { describe, expect, it } from "vitest";
import { createWorkspacePanelStorage } from "../src/client/workspace/useWorkspacePanelLayout";

const id = "texlite-workspace-layout";
const legacyKey = `react-resizable-panels:${id}`;
const ids = ["files", "source", "preview"];
const key = `${legacyKey}:${ids.join(":")}`;

function fixture(values: Record<string, string> = {}, panelIds = ids, groupId = id) {
  const data = new Map(Object.entries(values));
  const storage = createWorkspacePanelStorage(groupId, panelIds, () => ({
    getItem: (name) => data.get(name) ?? null,
    setItem: (name, value) => { data.set(name, value); }
  }));
  return { storage, data };
}

describe("workspace panel layout storage", () => {
  it("ignores v2 layout records without deleting existing browser data", () => {
    const legacy = JSON.stringify({ "files,preview,source": { layout: [18, 52, 30], expandToSizes: {} } });
    const { storage, data } = fixture({ [legacyKey]: legacy });
    expect(storage.getItem(key)).toBeNull();
    expect(data.get(legacyKey)).toBe(legacy);
    expect(storage.getItem(legacyKey)).toBeNull();
  });

  it("restores collapsed files and handles drawer/editor-only/PDF-only combinations", () => {
    for (const [panelIds, sizes] of [
      [ids, [0, 60, 40]],
      [["files", "source", "preview", "context"], [16, 34, 30, 20]],
      [["files", "source"], [20, 80]],
      [["preview"], [100]],
      [["preview", "context"], [76, 24]]
    ] as Array<[string[], number[]]>) {
      const layout = Object.fromEntries(panelIds.map((name, i) => [name, sizes[i]]));
      const currentKey = `${legacyKey}:${panelIds.join(":")}`;
      const { storage } = fixture({ [currentKey]: JSON.stringify(layout) }, panelIds);
      expect(JSON.parse(storage.getItem(currentKey)!)).toEqual(layout);
    }
  });

  it("reads and saves current records independently for each panel combination", () => {
    const { storage, data } = fixture({
      [legacyKey]: JSON.stringify({ "files,preview,source": { layout: [18, 52, 30] } }),
      [key]: JSON.stringify({ files: 20, source: 45, preview: 35 })
    });
    expect(JSON.parse(storage.getItem(key)!)).toEqual({ files: 20, source: 45, preview: 35 });
    storage.setItem(key, JSON.stringify({ files: 25, source: 40, preview: 35 }));
    expect(JSON.parse(data.get(key)!)).toEqual({ files: 25, source: 40, preview: 35 });
    const editorOnly = `${legacyKey}:files:source`;
    expect(storage.getItem(editorOnly)).toBeNull();
    storage.setItem(editorOnly, "{}");
    expect(data.has(editorOnly)).toBe(false);
  });

  it.each(["broken JSON", "null", "[]", '{"files":16}', '{"files":16,"source":42,"preview":-1}',
    '{"files":16,"source":42,"preview":"42"}', '{"files":16,"source":42,"unknown":42}',
    '{"files":16,"source":42,"preview":420}'])("ignores damaged saved preferences: %s", (saved) => {
    expect(fixture({
      [key]: saved,
      [legacyKey]: JSON.stringify({ "files,preview,source": { layout: [18, 52, 30] } })
    }).storage.getItem(key)).toBeNull();
  });

  it("isolates subpath deployments and tolerates blocked localStorage", () => {
    const scopedId = `${id}:base=%2Ftools%2Ftexlite`;
    const scopedKey = `react-resizable-panels:${scopedId}:${ids.join(":")}`;
    const { storage, data } = fixture({}, ids, scopedId);
    storage.setItem(scopedKey, JSON.stringify({ files: 16, source: 42, preview: 42 }));
    expect(data.has(key)).toBe(false);
    expect(storage.getItem(scopedKey)).not.toBeNull();
    const blocked = createWorkspacePanelStorage(id, ids, () => { throw new Error("Storage blocked"); });
    expect(blocked.getItem(key)).toBeNull();
    expect(() => blocked.setItem(key, "{}")).not.toThrow();
  });
});
