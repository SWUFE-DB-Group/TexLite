import type { IndexeddbPersistence } from "y-indexeddb";

/**
 * Clear the y-indexeddb document in one transaction, without deleting the
 * database or forcing other connections closed. The read puts the check at
 * the head of the write queue: later IndexedDB writes cannot get swept up.
 */
export async function clearCollaborationDraftCache(
  persistence: IndexeddbPersistence,
  prepare: () => boolean
): Promise<boolean> {
  const db = persistence.db ?? await persistence._db;
  return new Promise((resolve, reject) => {
    // The two stores are the schema used by y-indexeddb.
    const transaction = db.transaction(["updates", "custom"], "readwrite");
    const updates = transaction.objectStore("updates");
    const ready = updates.openKeyCursor();
    let cleared = false;
    let failure: unknown;
    transaction.oncomplete = () => resolve(cleared);
    transaction.onabort = () => reject(failure ?? transaction.error ?? new Error("Local draft cleanup aborted"));
    ready.onsuccess = () => {
      try {
        if (!prepare()) return;
        updates.clear();
        transaction.objectStore("custom").clear();
        cleared = true;
      } catch (error) {
        failure = error;
        transaction.abort();
      }
    };
  });
}
