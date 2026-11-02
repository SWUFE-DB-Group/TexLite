import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import type { FastifyInstance } from "fastify";
import type { DatabaseConnection } from "./db.js";
import { requireUser } from "./auth.js";
import { contentDisposition, httpError, ValidationError } from "./http.js";

function collection(db: DatabaseConnection, userId: string, id: string): { id: string; name: string } {
  const row = db.prepare("SELECT id, name FROM citation_library_collections WHERE id = ? AND user_id = ?").get(id, userId) as { id: string; name: string } | undefined;
  if (!row) throw httpError(404, "CITATION_COLLECTION_NOT_FOUND");
  return row;
}

function collectionName(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 80) throw httpError(400, "CITATION_COLLECTION_NAME_INVALID");
  return value.trim();
}

export function citationCollectionIds(db: DatabaseConnection, userId: string, value: unknown): string[] | null {
  if (value === undefined) return null;
  if (!Array.isArray(value) || value.length > 100 || value.some((id) => typeof id !== "string" || !id.trim())) throw new ValidationError();
  const ids = [...new Set(value.map((id: string) => id.trim()))];
  if (ids.length) {
    const rows = db.prepare(`SELECT id FROM citation_library_collections WHERE user_id = ? AND id IN (${ids.map(() => "?").join(",")})`).all(userId, ...ids);
    if (rows.length !== ids.length) throw httpError(404, "CITATION_COLLECTION_NOT_FOUND");
  }
  return ids;
}

export function citationCollectionsForEntries(db: DatabaseConnection, entryIds: string[]): Map<string, string[]> {
  const result = new Map(entryIds.map((id) => [id, [] as string[]]));
  if (!entryIds.length) return result;
  const rows = db.prepare(`SELECT link.entry_id, link.collection_id FROM citation_library_entry_collections link
    JOIN citation_library_collections folder ON folder.id = link.collection_id
    JOIN citation_library_entries entry ON entry.id = link.entry_id AND entry.user_id = folder.user_id
    WHERE link.entry_id IN (${entryIds.map(() => "?").join(",")}) ORDER BY folder.name COLLATE NOCASE`)
    .all(...entryIds) as Array<{ entry_id: string; collection_id: string }>;
  for (const row of rows) result.get(row.entry_id)?.push(row.collection_id);
  return result;
}

export function filterCitationCollection(db: DatabaseConnection, userId: string, selected: string, where: string[], params: Array<string | number>): void {
  if (!selected) return;
  if (selected === "unfiled") {
    where.push(`NOT EXISTS (SELECT 1 FROM citation_library_entry_collections link
      JOIN citation_library_collections folder ON folder.id = link.collection_id AND folder.user_id = entry.user_id
      WHERE link.entry_id = entry.id)`);
  } else {
    collection(db, userId, selected);
    where.push("EXISTS (SELECT 1 FROM citation_library_entry_collections link WHERE link.entry_id = entry.id AND link.collection_id = ?)");
    params.push(selected);
  }
}

/** Collections are private organizational metadata, never project membership. */
export function registerCitationCollectionRoutes(app: FastifyInstance, db: DatabaseConnection): void {
  app.get("/api/citations/collections", async (request, reply) => {
    const user = requireUser(request, reply, db); if (!user) return;
    const collections = db.prepare(`SELECT folder.id, folder.name, COUNT(entry.id) AS entryCount FROM citation_library_collections folder
      LEFT JOIN citation_library_entry_collections link ON link.collection_id = folder.id
      LEFT JOIN citation_library_entries entry ON entry.id = link.entry_id AND entry.user_id = folder.user_id
      WHERE folder.user_id = ? GROUP BY folder.id ORDER BY folder.name COLLATE NOCASE`).all(user.id);
    const totals = db.prepare(`SELECT COUNT(*) AS total, COALESCE(SUM(NOT EXISTS (
      SELECT 1 FROM citation_library_entry_collections link JOIN citation_library_collections folder
        ON folder.id = link.collection_id AND folder.user_id = entry.user_id
      WHERE link.entry_id = entry.id)), 0) AS unfiled FROM citation_library_entries entry WHERE user_id = ?`).get(user.id) as { total: number; unfiled: number };
    return { collections, ...totals };
  });
  app.post("/api/citations/collections", async (request, reply) => {
    const user = requireUser(request, reply, db); if (!user) return;
    const name = collectionName((request.body as { name?: unknown } | undefined)?.name);
    if (db.prepare("SELECT id FROM citation_library_collections WHERE user_id = ? AND name = ? COLLATE NOCASE").get(user.id, name)) throw httpError(409, "CITATION_COLLECTION_NAME_EXISTS");
    const id = randomUUID();
    db.prepare("INSERT INTO citation_library_collections (id, user_id, name, created_at) VALUES (?, ?, ?, ?)").run(id, user.id, name, new Date().toISOString());
    return reply.code(201).send({ collection: { id, name, entryCount: 0 } });
  });
  app.patch("/api/citations/collections/:collectionId", async (request, reply) => {
    const user = requireUser(request, reply, db); if (!user) return;
    const { collectionId } = request.params as { collectionId: string };
    collection(db, user.id, collectionId);
    const name = collectionName((request.body as { name?: unknown } | undefined)?.name);
    if (db.prepare("SELECT id FROM citation_library_collections WHERE user_id = ? AND name = ? COLLATE NOCASE AND id != ?").get(user.id, name, collectionId)) throw httpError(409, "CITATION_COLLECTION_NAME_EXISTS");
    db.prepare("UPDATE citation_library_collections SET name = ? WHERE id = ? AND user_id = ?").run(name, collectionId, user.id);
    return { ok: true };
  });
  app.delete("/api/citations/collections/:collectionId", async (request, reply) => {
    const user = requireUser(request, reply, db); if (!user) return;
    const { collectionId } = request.params as { collectionId: string };
    const result = db.prepare("DELETE FROM citation_library_collections WHERE id = ? AND user_id = ?").run(collectionId, user.id);
    if (!result.changes) throw httpError(404, "CITATION_COLLECTION_NOT_FOUND");
    return { ok: true };
  });
  app.get("/api/citations/collections/:collectionId/export", async (request, reply) => {
    const user = requireUser(request, reply, db); if (!user) return;
    const { collectionId } = request.params as { collectionId: string };
    const folder = collection(db, user.id, collectionId);
    const statement = db.prepare(`SELECT entry.bibtex FROM citation_library_entries entry
      JOIN citation_library_entry_collections link ON link.entry_id = entry.id
      WHERE entry.user_id = ? AND link.collection_id = ? ORDER BY entry.citation_key COLLATE NOCASE, entry.id`);
    reply.header("Cache-Control", "private, no-store");
    reply.header("X-Content-Type-Options", "nosniff");
    // File names are labels, not paths. Preserve Unicode via Content-Disposition.
    reply.header("Content-Disposition", contentDisposition(`${folder.name.replace(/[\x00-\x1f\x7f/\\]/g, "_")}.bib`, "attachment"));
    reply.type("application/x-bibtex; charset=utf-8");
    return reply.send(Readable.from((function* () {
      for (const row of statement.iterate(user.id, collectionId) as Iterable<{ bibtex: string }>) yield `${row.bibtex.trim()}\n\n`;
    })()));
  });
}
