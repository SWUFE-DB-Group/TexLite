import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isLocalStorageEvent, readStorage, readStorageJson, removeStorage, storageKeys, writeStorage, writeStorageJson
} from "../src/client/browserStorage";

class MemoryStorage {
  readonly values = new Map<string, string>();
  get length() { return this.values.size; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}

afterEach(() => vi.unstubAllGlobals());

describe("browser storage", () => {
  it("reads, writes and removes values, and parses JSON defensively", () => {
    const storage = new MemoryStorage();
    vi.stubGlobal("localStorage", storage);
    expect(writeStorage("a", "1")).toBe(true);
    expect(writeStorageJson("b", { on: true })).toBe(true);
    storage.setItem("broken", "{not json");
    expect(readStorage("a")).toBe("1");
    expect(readStorageJson("b")).toEqual({ on: true });
    expect(readStorageJson("broken")).toBeUndefined();
    expect(readStorageJson("missing")).toBeUndefined();
    expect(storageKeys()).toEqual(["a", "b", "broken"]);
    removeStorage("a");
    expect(readStorage("a")).toBeNull();
  });

  it("behaves as empty storage when the browser blocks access or refuses writes", () => {
    const blocked = () => { throw new DOMException("Access denied", "SecurityError"); };
    vi.stubGlobal("localStorage", { getItem: blocked, setItem: blocked, removeItem: blocked, key: blocked, get length() { return blocked(); } });
    expect(readStorage("a")).toBeNull();
    expect(readStorageJson("a")).toBeUndefined();
    expect(writeStorage("a", "1")).toBe(false);
    expect(writeStorageJson("a", [1])).toBe(false);
    expect(() => removeStorage("a")).not.toThrow();
    expect(storageKeys()).toEqual([]);
  });

  it("recognizes storage events from localStorage only", () => {
    const storage = new MemoryStorage();
    vi.stubGlobal("localStorage", storage);
    expect(isLocalStorageEvent({ storageArea: storage } as unknown as StorageEvent)).toBe(true);
    expect(isLocalStorageEvent({ storageArea: new MemoryStorage() } as unknown as StorageEvent)).toBe(false);
  });
});
