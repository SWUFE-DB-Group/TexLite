import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { requireUser } from "../auth.js";
import type { DatabaseConnection } from "../db.js";
import { apiError, httpError, ValidationError } from "../http.js";
import { MAX_CITATION_BIBTEX_BYTES } from "../limits.js";
import { citationCollectionIds, citationCollectionsForEntries, filterCitationCollection, registerCitationCollectionRoutes } from "../citationCollections.js";
import { comparableCitationBibtex } from "../../shared/citationContent.js";
import { citationInput } from "../citationInput.js";

interface CitationRouteContext {
  db: DatabaseConnection;
}

const tagColors = ["red", "orange", "yellow", "green", "blue", "purple", "gray"] as const;
const now = (): string => new Date().toISOString();

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

function text(value: unknown, max = 200): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new ValidationError();
  }
  return value.trim();
}

interface CitationLibraryRow {
  id: string;
  user_id: string;
  citation_key: string;
  entry_type: string;
  bibtex: string;
  notes: string;
  title: string | null;
  authors: string | null;
  year: string | null;
  revision: number;
  created_at: string;
  updated_at: string;
  owner_username?: string;
  owner_display_name?: string;
}

interface CitationLibraryTagRow {
  id: string;
  name: string;
  color: typeof tagColors[number];
  user_id: string;
}

function citationJson(row: CitationLibraryRow, tags: CitationLibraryTagRow[] = [], collectionIds: string[] = []) {
  return {
    id: row.id,
    citationKey: row.citation_key,
    entryType: row.entry_type,
    bibtex: row.bibtex,
    notes: row.notes,
    title: row.title,
    authors: row.authors,
    year: row.year,
    revision: row.revision,
    collectionIds,
    tags: tags.map((tag) => ({ id: tag.id, name: tag.name, color: tag.color, ownerId: tag.user_id })),
    ownerId: row.user_id,
    ownerUsername: row.owner_username ?? null,
    ownerDisplayName: row.owner_display_name ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function citationDetails(db: DatabaseConnection, row: CitationLibraryRow) {
  return citationJson(row, citationTagsForEntries(db, [row.id]).get(row.id), citationCollectionsForEntries(db, [row.id]).get(row.id));
}

function citationTagsForEntries(db: DatabaseConnection, entryIds: string[]): Map<string, CitationLibraryTagRow[]> {
  const result = new Map(entryIds.map((entryId) => [entryId, [] as CitationLibraryTagRow[]]));
  if (!entryIds.length) return result;
  const placeholders = entryIds.map(() => "?").join(", ");
  const rows = db.prepare(`SELECT link.entry_id, tag.id, tag.name, tag.color, tag.user_id
    FROM citation_library_entry_tags link JOIN citation_library_tags tag ON tag.id = link.tag_id
    JOIN citation_library_entries entry ON entry.id = link.entry_id AND entry.user_id = tag.user_id
    WHERE link.entry_id IN (${placeholders})
    ORDER BY tag.name COLLATE NOCASE`).all(...entryIds) as Array<CitationLibraryTagRow & { entry_id: string }>;
  for (const row of rows) result.get(row.entry_id)?.push({ id: row.id, name: row.name, color: row.color, user_id: row.user_id });
  return result;
}

function citationTagIds(db: DatabaseConnection, userId: string, value: unknown): string[] | null {
  if (value === undefined) return null;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new ValidationError();
  const ids = [...new Set(value.map((item) => item.trim()).filter(Boolean))];
  if (ids.length > 100) throw new ValidationError();
  if (!ids.length) return [];
  const placeholders = ids.map(() => "?").join(", ");
  const rows = db.prepare(`SELECT id FROM citation_library_tags WHERE user_id = ? AND id IN (${placeholders})`)
    .all(userId, ...ids) as Array<{ id: string }>;
  if (rows.length !== ids.length) throw httpError(404, "CITATION_TAG_NOT_FOUND");
  return ids;
}

function citationTagName(value: unknown): string {
  return text(value, 32);
}

function citationExpectedRevision(value: unknown): number {
  if (!Number.isInteger(value) || Number(value) < 1) {
    throw new ValidationError();
  }
  return Number(value);
}


/** Register the current user's private citation-library routes. */
export function registerCitationRoutes(app: FastifyInstance, context: CitationRouteContext): void {
  const { db } = context;
  registerCitationCollectionRoutes(app, db);

  app.get("/api/citations", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const query = request.query as { q?: string; tag?: string; collection?: string; page?: string; pageSize?: string; limit?: string };
    const search = typeof query.q === "string" ? query.q.trim() : "";
    const tagId = typeof query.tag === "string" ? query.tag.trim() : "";
    const requestedPage = Number.parseInt(query.page ?? "1", 10);
    const requestedPageSize = Number.parseInt(query.pageSize ?? query.limit ?? "60", 10);
    const pageSize = Math.min(200, Math.max(1, Number.isFinite(requestedPageSize) ? requestedPageSize : 60));
    const where = ["entry.user_id = ?"];
    const params: Array<string | number> = [user.id];
    filterCitationCollection(db, user.id, typeof query.collection === "string" ? query.collection.trim() : "", where, params);
    if (search) {
      where.push(`(
            citation_key LIKE ? ESCAPE '\\' OR entry_type LIKE ? ESCAPE '\\'
            OR COALESCE(title, '') LIKE ? ESCAPE '\\'
            OR COALESCE(authors, '') LIKE ? ESCAPE '\\'
            OR COALESCE(year, '') LIKE ? ESCAPE '\\'
          )`);
      params.push(...Array.from({ length: 5 }, () => `%${escapeLikePattern(search)}%`));
    }
    if (tagId) {
      where.push(`EXISTS (SELECT 1 FROM citation_library_entry_tags filter_link
        JOIN citation_library_tags filter_tag ON filter_tag.id = filter_link.tag_id
        WHERE filter_link.entry_id = entry.id AND filter_link.tag_id = ? AND filter_tag.user_id = ?)`);
      params.push(tagId, user.id);
    }
    const countRow = db.prepare(`SELECT COUNT(*) AS count
      FROM citation_library_entries entry
      WHERE ${where.join(" AND ")}`).get(...params) as { count: number };
    const total = Number(countRow.count) || 0;
    const totalPages = total > 0 ? Math.ceil(total / pageSize) : 0;
    const page = totalPages > 0 ? Math.min(Math.max(1, Number.isFinite(requestedPage) ? requestedPage : 1), totalPages) : 1;
    const offset = (page - 1) * pageSize;
    params.push(pageSize, offset);
    const rows = db.prepare(`SELECT entry.*, owner.username AS owner_username, owner.display_name AS owner_display_name
      FROM citation_library_entries entry
      JOIN users owner ON owner.id = entry.user_id
      WHERE ${where.join(" AND ")} ORDER BY entry.updated_at DESC, entry.citation_key COLLATE NOCASE LIMIT ? OFFSET ?`).all(...params) as CitationLibraryRow[];
    const tags = citationTagsForEntries(db, rows.map((row) => row.id));
    const collections = citationCollectionsForEntries(db, rows.map((row) => row.id));
    return {
      entries: rows.map((row) => citationJson(row, tags.get(row.id), collections.get(row.id))),
      pagination: { page, pageSize, total, totalPages }
    };
  });

  app.get("/api/citations/tags", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const tags = db.prepare(`SELECT tag.id, tag.name, tag.color, tag.user_id AS owner_id
      FROM citation_library_tags tag
      WHERE tag.user_id = ?
      ORDER BY tag.name COLLATE NOCASE`).all(user.id) as Array<{ id: string; name: string; color: typeof tagColors[number]; owner_id: string }>;
    return { tags: tags.map((tag) => ({ id: tag.id, name: tag.name, color: tag.color, ownerId: tag.owner_id })) };
  });

  app.post("/api/citations/tags", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const body = request.body as { name?: unknown; color?: unknown } | undefined;
    const name = citationTagName(body?.name);
    const color = tagColors.includes(body?.color as typeof tagColors[number]) ? body?.color as typeof tagColors[number] : "gray";
    const existing = db.prepare("SELECT id, name, color, user_id FROM citation_library_tags WHERE user_id = ? AND name = ? COLLATE NOCASE").get(user.id, name) as CitationLibraryTagRow | undefined;
    if (existing) return { tag: { id: existing.id, name: existing.name, color: existing.color, ownerId: existing.user_id }, created: false };
    const tag = { id: randomUUID(), name, color, ownerId: user.id };
    db.prepare("INSERT INTO citation_library_tags (id, user_id, name, color, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(tag.id, user.id, tag.name, tag.color, now());
    return reply.code(201).send({ tag, created: true });
  });

  app.patch("/api/citations/tags/:tagId", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { tagId } = request.params as { tagId: string };
    const existing = db.prepare("SELECT id, name, color, user_id FROM citation_library_tags WHERE id = ? AND user_id = ?")
      .get(tagId, user.id) as CitationLibraryTagRow | undefined;
    if (!existing) return apiError(reply, 404, "CITATION_TAG_NOT_FOUND");
    const body = request.body as { name?: unknown; color?: unknown } | undefined;
    const name = body?.name === undefined ? existing.name : citationTagName(body.name);
    const color = body?.color === undefined ? existing.color : body.color;
    if (!tagColors.includes(color as typeof tagColors[number])) throw new ValidationError();
    const duplicate = db.prepare("SELECT id FROM citation_library_tags WHERE user_id = ? AND name = ? COLLATE NOCASE AND id != ?")
      .get(user.id, name, tagId);
    if (duplicate) return apiError(reply, 409, "CITATION_TAG_NAME_EXISTS");
    db.prepare("UPDATE citation_library_tags SET name = ?, color = ? WHERE id = ? AND user_id = ?")
      .run(name, color, tagId, user.id);
    return { tag: { id: tagId, name, color, ownerId: user.id } };
  });

  app.delete("/api/citations/tags/:tagId", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { tagId } = request.params as { tagId: string };
    const result = db.prepare("DELETE FROM citation_library_tags WHERE id = ? AND user_id = ?").run(tagId, user.id);
    if (!result.changes) return apiError(reply, 404, "CITATION_TAG_NOT_FOUND");
    return { ok: true };
  });

  // Keep the old settings endpoint explicit so stale clients cannot accidentally
  // reinterpret "settings" as a citation id. Citation libraries are always private.
  app.patch("/api/citations/settings", async (request, reply) => {
    if (!requireUser(request, reply, db)) return;
    return apiError(reply, 403, "CITATION_LIBRARY_PRIVATE");
  });

  app.post("/api/citations/lookup", { bodyLimit: MAX_CITATION_BIBTEX_BYTES * 8 }, async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const body = request.body as { keys?: unknown; entries?: unknown } | undefined;
    let contents: Map<string, string> | null = null;
    let keyInput: unknown = body?.keys;
    if (body?.entries !== undefined) {
      if (body.keys !== undefined || !Array.isArray(body.entries) || body.entries.length > 5000) throw new ValidationError();
      contents = new Map();
      let bytes = 0;
      keyInput = body.entries.map((value: unknown) => {
        if (typeof value !== "object" || !value) throw new ValidationError();
        const item = value as { citationKey?: unknown; bibtex?: unknown };
        if (typeof item.citationKey !== "string" || typeof item.bibtex !== "string" || !item.bibtex.trim()) throw new ValidationError();
        bytes += Buffer.byteLength(item.bibtex, "utf8");
        if (bytes > MAX_CITATION_BIBTEX_BYTES) throw httpError(413, "CITATION_TOO_LARGE");
        contents!.set(item.citationKey.trim().toLowerCase(), comparableCitationBibtex(item.bibtex));
        return item.citationKey;
      });
    }
    if (!Array.isArray(keyInput) || keyInput.length > 5000
      || keyInput.some((key) => typeof key !== "string" || !key.trim() || key.length > 512)) {
      throw new ValidationError();
    }
    const keys = [...new Map(keyInput.map((key: string) => [key.trim().toLowerCase(), key.trim()] as const)).values()];
    const matches: Array<{ id: string; citationKey: string; revision: number; sameContent?: boolean }> = [];
    for (let offset = 0; offset < keys.length; offset += 500) {
      const chunk = keys.slice(offset, offset + 500);
      const placeholders = chunk.map(() => "?").join(", ");
      const rows = db.prepare(`SELECT id, citation_key, revision${contents ? ", bibtex" : ""} FROM citation_library_entries
        WHERE user_id = ? AND citation_key COLLATE NOCASE IN (${placeholders})`)
        .iterate(user.id, ...chunk) as Iterable<{ id: string; citation_key: string; revision: number; bibtex: string }>;
      for (const row of rows) matches.push({ id: row.id, citationKey: row.citation_key, revision: row.revision,
        ...(contents ? { sameContent: comparableCitationBibtex(row.bibtex) === contents.get(row.citation_key.toLowerCase()) } : {}) });
    }
    return { matches };
  });

  app.post("/api/citations", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const body = request.body as { bibtex?: unknown; citationKey?: unknown; entryType?: unknown; title?: unknown; authors?: unknown; year?: unknown; tagIds?: unknown; collectionIds?: unknown; overwrite?: unknown; expectedRevision?: unknown } | undefined;
    const citation = citationInput(body);
    const tagIds = citationTagIds(db, user.id, body?.tagIds);
    const collectionIds = citationCollectionIds(db, user.id, body?.collectionIds);
    const overwrite = body?.overwrite === true;
    const existing = db.prepare("SELECT id, revision FROM citation_library_entries WHERE user_id = ? AND citation_key = ? COLLATE NOCASE")
      .get(user.id, citation.citationKey) as { id: string; revision: number } | undefined;
    if (existing && !overwrite) return apiError(reply, 409, "CITATION_KEY_EXISTS");
    const expectedRevision = existing ? citationExpectedRevision(body?.expectedRevision) : null;
    if (existing && existing.revision !== expectedRevision) {
      return apiError(reply, 409, "CITATION_CONFLICT");
    }
    const id = existing?.id ?? randomUUID();
    const timestamp = now();
    db.transaction(() => {
      if (existing) {
        const result = db.prepare(`UPDATE citation_library_entries SET citation_key = ?, entry_type = ?, bibtex = ?,
          title = ?, authors = ?, year = ?, notes = COALESCE(?, notes), revision = revision + 1, updated_at = ?
          WHERE id = ? AND user_id = ? AND revision = ?`)
          .run(citation.citationKey, citation.entryType, citation.bibtex, citation.title, citation.authors, citation.year,
            citation.notes ?? null, timestamp, id, user.id, expectedRevision);
        if (!result.changes) throw httpError(409, "CITATION_CONFLICT");
      } else {
        db.prepare(`INSERT INTO citation_library_entries
          (id, user_id, citation_key, entry_type, bibtex, title, authors, year, notes, revision, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`)
          .run(id, user.id, citation.citationKey, citation.entryType, citation.bibtex, citation.title, citation.authors, citation.year, citation.notes ?? "", timestamp, timestamp);
      }
      if (tagIds !== null) {
        db.prepare("DELETE FROM citation_library_entry_tags WHERE entry_id = ?").run(id);
        for (const tagId of tagIds) db.prepare("INSERT INTO citation_library_entry_tags (entry_id, tag_id, created_at) VALUES (?, ?, ?)").run(id, tagId, timestamp);
      }
      // Saving from a project's .bib adds the chosen folder without removing
      // other placements of an already-saved reference.
      for (const collectionId of collectionIds ?? []) db.prepare("INSERT OR IGNORE INTO citation_library_entry_collections (entry_id, collection_id) VALUES (?, ?)").run(id, collectionId);
    })();
    const row = db.prepare("SELECT * FROM citation_library_entries WHERE id = ? AND user_id = ?")
      .get(id, user.id) as CitationLibraryRow;
    return reply.code(existing ? 200 : 201).send({ entry: citationDetails(db, row), updated: Boolean(existing) });
  });

  app.patch("/api/citations/:citationId/tags", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { citationId } = request.params as { citationId: string };
    const existing = db.prepare("SELECT id FROM citation_library_entries WHERE id = ? AND user_id = ?")
      .get(citationId, user.id) as { id: string } | undefined;
    if (!existing) return apiError(reply, 404, "CITATION_NOT_FOUND");
    const body = request.body as { tagIds?: unknown; expectedRevision?: unknown } | undefined;
    const tagIds = citationTagIds(db, user.id, body?.tagIds);
    if (tagIds === null) throw new ValidationError();
    const expectedRevision = citationExpectedRevision(body?.expectedRevision);
    const timestamp = now();
    db.transaction(() => {
      const result = db.prepare(`UPDATE citation_library_entries SET revision = revision + 1, updated_at = ?
        WHERE id = ? AND user_id = ? AND revision = ?`).run(timestamp, citationId, user.id, expectedRevision);
      if (!result.changes) {
        const exists = db.prepare("SELECT id FROM citation_library_entries WHERE id = ? AND user_id = ?").get(citationId, user.id);
        if (!exists) throw httpError(404, "CITATION_NOT_FOUND");
        throw httpError(409, "CITATION_CONFLICT");
      }
      db.prepare("DELETE FROM citation_library_entry_tags WHERE entry_id = ?").run(citationId);
      for (const tagId of tagIds) db.prepare("INSERT INTO citation_library_entry_tags (entry_id, tag_id, created_at) VALUES (?, ?, ?)").run(citationId, tagId, timestamp);
    })();
    const row = db.prepare("SELECT * FROM citation_library_entries WHERE id = ? AND user_id = ?")
      .get(citationId, user.id) as CitationLibraryRow;
    return { entry: citationDetails(db, row) };
  });

  app.patch("/api/citations/:citationId/collections", async (request, reply) => {
    const user = requireUser(request, reply, db); if (!user) return;
    const { citationId } = request.params as { citationId: string };
    if (!db.prepare("SELECT id FROM citation_library_entries WHERE id = ? AND user_id = ?").get(citationId, user.id)) throw httpError(404, "CITATION_NOT_FOUND");
    const body = request.body as { collectionIds?: unknown; expectedRevision?: unknown } | undefined;
    const collectionIds = citationCollectionIds(db, user.id, body?.collectionIds);
    if (collectionIds === null) throw new ValidationError();
    const revision = citationExpectedRevision(body?.expectedRevision);
    db.transaction(() => {
      const result = db.prepare("UPDATE citation_library_entries SET revision = revision + 1, updated_at = ? WHERE id = ? AND user_id = ? AND revision = ?").run(now(), citationId, user.id, revision);
      if (!result.changes) throw httpError(409, "CITATION_CONFLICT");
      db.prepare("DELETE FROM citation_library_entry_collections WHERE entry_id = ?").run(citationId);
      const insert = db.prepare("INSERT INTO citation_library_entry_collections (entry_id, collection_id) VALUES (?, ?)");
      for (const id of collectionIds) insert.run(citationId, id);
    })();
    const row = db.prepare("SELECT * FROM citation_library_entries WHERE id = ? AND user_id = ?").get(citationId, user.id) as CitationLibraryRow;
    return { entry: citationDetails(db, row) };
  });

  app.patch("/api/citations/:citationId", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { citationId } = request.params as { citationId: string };
    const existing = db.prepare("SELECT id FROM citation_library_entries WHERE id = ? AND user_id = ?")
      .get(citationId, user.id) as { id: string } | undefined;
    if (!existing) return apiError(reply, 404, "CITATION_NOT_FOUND");
    const body = request.body as { bibtex?: unknown; citationKey?: unknown; entryType?: unknown; title?: unknown; authors?: unknown; year?: unknown; expectedRevision?: unknown } | undefined;
    const citation = citationInput(body);
    const expectedRevision = citationExpectedRevision(body?.expectedRevision);
    const duplicate = db.prepare("SELECT id FROM citation_library_entries WHERE user_id = ? AND citation_key = ? COLLATE NOCASE AND id != ?")
      .get(user.id, citation.citationKey, citationId) as { id: string } | undefined;
    if (duplicate) return apiError(reply, 409, "CITATION_KEY_EXISTS");
    const result = db.prepare(`UPDATE citation_library_entries SET citation_key = ?, entry_type = ?, bibtex = ?,
      title = ?, authors = ?, year = ?, notes = COALESCE(?, notes), revision = revision + 1, updated_at = ?
      WHERE id = ? AND user_id = ? AND revision = ?`)
      .run(citation.citationKey, citation.entryType, citation.bibtex, citation.title, citation.authors, citation.year,
        citation.notes ?? null, now(), citationId, user.id, expectedRevision);
    if (!result.changes) return apiError(reply, 409, "CITATION_CONFLICT");
    const updated = db.prepare("SELECT * FROM citation_library_entries WHERE id = ? AND user_id = ?")
      .get(citationId, user.id) as CitationLibraryRow;
    return { entry: citationDetails(db, updated) };
  });

  app.delete("/api/citations/:citationId", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { citationId } = request.params as { citationId: string };
    const result = db.prepare("DELETE FROM citation_library_entries WHERE id = ? AND user_id = ?").run(citationId, user.id);
    if (!result.changes) return apiError(reply, 404, "CITATION_NOT_FOUND");
    return { ok: true };
  });
}
