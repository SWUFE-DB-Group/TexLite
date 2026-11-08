/**
 * Safe access to `localStorage` for per-browser conveniences (preferences,
 * layout, review marks). Storage can be unavailable or refuse writes in private
 * windows, with blocked site data, or when its quota is full; every access then
 * behaves as if nothing were stored, so a page never fails because of it.
 * Keys should come from `scopedStorageKey` so instances below different base
 * paths do not share values.
 */

/** The page's localStorage; `window` and `globalThis` are the same object in a browser. */
function storage(): Storage {
  return (typeof window !== "undefined" ? window : globalThis).localStorage;
}

export function readStorage(key: string): string | null {
  try { return storage().getItem(key); } catch { return null; }
}

/** Returns whether the value was stored. */
export function writeStorage(key: string, value: string): boolean {
  try { storage().setItem(key, value); return true; } catch { return false; }
}

export function removeStorage(key: string): void {
  try { storage().removeItem(key); } catch { /* Nothing to remove when storage is unavailable. */ }
}

/** All stored keys, or none when storage is unavailable. */
export function storageKeys(): string[] {
  try {
    const keys: string[] = [];
    for (let index = 0; index < storage().length; index += 1) {
      const key = storage().key(index);
      if (key) keys.push(key);
    }
    return keys;
  } catch {
    return [];
  }
}

/** The parsed JSON value, or undefined when it is missing, unreadable or not JSON. */
export function readStorageJson(key: string): unknown {
  const value = readStorage(key);
  if (value === null) return undefined;
  try { return JSON.parse(value); } catch { return undefined; }
}

/** Returns whether the value was stored. */
export function writeStorageJson(key: string, value: unknown): boolean {
  return writeStorage(key, JSON.stringify(value));
}

/** A `storage` event came from this origin's localStorage (not sessionStorage). */
export function isLocalStorageEvent(event: StorageEvent): boolean {
  try { return event.storageArea === storage(); } catch { return false; }
}
