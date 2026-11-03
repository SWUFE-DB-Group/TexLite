import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { CITATION_FOLDER_FORMAT, CITATION_FOLDER_VERSION, MAX_CITATION_FOLDER_BYTES, MAX_CITATION_FOLDER_ENTRIES,
  type CitationFolderBundle, type CitationFolderImportRequest, type CitationTransferEntry } from "../shared/citationTransfer.js";
import { requireUser } from "./auth.js";
import { citationInput } from "./citationInput.js";
import type { DatabaseConnection } from "./db.js";
import { httpError } from "./http.js";

/** Export only portable content, never tags, owner identifiers or internal folder IDs. */
export function exportCitationFolder(db: DatabaseConnection, userId: string, folder: { id: string }): string {
  const bundle: CitationFolderBundle = { format: CITATION_FOLDER_FORMAT, version: CITATION_FOLDER_VERSION, entries: [] };
  let bytes = Buffer.byteLength(JSON.stringify(bundle), "utf8");
  const rows = db.prepare(`SELECT entry.citation_key AS citationKey, entry.entry_type AS entryType,
    entry.bibtex, entry.title, entry.authors, entry.year, entry.notes
    FROM citation_library_entries entry JOIN citation_library_entry_collections link ON link.entry_id = entry.id
    WHERE entry.user_id = ? AND link.collection_id = ? ORDER BY entry.citation_key COLLATE NOCASE, entry.id`)
    .iterate(userId, folder.id) as Iterable<CitationTransferEntry>;
  for (const row of rows) {
    bytes += Buffer.byteLength(JSON.stringify(row), "utf8") + (bundle.entries.length ? 1 : 0);
    if (bytes > MAX_CITATION_FOLDER_BYTES || bundle.entries.length >= MAX_CITATION_FOLDER_ENTRIES) throw httpError(413, "CITATION_FOLDER_TOO_LARGE");
    bundle.entries.push(row);
  }
  return JSON.stringify(bundle);
}

export function registerCitationFolderImport(app: FastifyInstance, db: DatabaseConnection): void {
  app.post("/api/citations/collections/import", { bodyLimit: MAX_CITATION_FOLDER_BYTES }, async (request, reply) => {
    const user = requireUser(request, reply, db); if (!user) return;
    const body = request.body as Partial<CitationFolderImportRequest> | null;
    if (!body || body.format !== CITATION_FOLDER_FORMAT || body.version !== CITATION_FOLDER_VERSION
      || typeof body.name !== "string" || !body.name.trim() || body.name.trim().length > 80
      || !Array.isArray(body.entries)) throw httpError(400, "CITATION_FOLDER_INVALID");
    if (body.entries.length > MAX_CITATION_FOLDER_ENTRIES) throw httpError(413, "CITATION_FOLDER_TOO_LARGE");
    // Validate the entire import before opening a write transaction. Repeated
    // keys in the bundle follow the same last-entry-wins rule as existing keys.
    const entries = new Map<string, ReturnType<typeof citationInput>>();
    for (const value of body.entries) {
      if (!value || typeof value.notes !== "string") throw httpError(400, "CITATION_FOLDER_INVALID");
      const entry = citationInput(value);
      entries.set(entry.citationKey.toLowerCase(), entry);
    }
    const timestamp = new Date().toISOString();
    const id = randomUUID();
    const baseName = body.name.trim();
    const name = db.transaction(() => {
      let candidate = baseName, suffix = 0;
      const exists = db.prepare("SELECT 1 FROM citation_library_collections WHERE user_id = ? AND name = ? COLLATE NOCASE");
      while (exists.get(user.id, candidate)) {
        const ending = `-${++suffix}`;
        candidate = `${baseName.slice(0, 80 - ending.length)}${ending}`;
      }
      db.prepare("INSERT INTO citation_library_collections (id, user_id, name, created_at) VALUES (?, ?, ?, ?)").run(id, user.id, candidate, timestamp);
      const upsert = db.prepare(`INSERT INTO citation_library_entries
        (id, user_id, citation_key, entry_type, bibtex, title, authors, year, notes, revision, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
        ON CONFLICT (user_id, citation_key) DO UPDATE SET citation_key = excluded.citation_key,
          entry_type = excluded.entry_type, bibtex = excluded.bibtex, title = excluded.title,
          authors = excluded.authors, year = excluded.year, notes = excluded.notes,
          revision = citation_library_entries.revision + 1, updated_at = excluded.updated_at
        RETURNING id`);
      const place = db.prepare("INSERT INTO citation_library_entry_collections (entry_id, collection_id) VALUES (?, ?)");
      for (const entry of entries.values()) {
        const saved = upsert.get(randomUUID(), user.id, entry.citationKey, entry.entryType, entry.bibtex,
          entry.title, entry.authors, entry.year, entry.notes!, timestamp, timestamp) as { id: string };
        // Existing placements and tags are retained. Imported content replaces
        // the user's shared entry, so all its placements see the updated notes.
        place.run(saved.id, id);
      }
      return candidate;
    })();
    return reply.code(201).send({ collection: { id, name, entryCount: entries.size }, imported: entries.size });
  });
}
