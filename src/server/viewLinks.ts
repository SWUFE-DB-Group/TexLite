import type { FastifyRequest } from "fastify";
import type { DatabaseConnection } from "./db.js";
import { digestToken } from "./security.js";
import { httpError } from "./http.js";
import type { ProjectViewLink } from "../shared/projectViewLinks.js";

export interface ViewLinkRow {
  id: string; project_id: string; token_hash: string; token_ciphertext: string | null; label: string;
  created_at: string; expires_at: string | null;
}

export function viewLinkJson(row: ViewLinkRow, path: string | null): ProjectViewLink {
  return { id: row.id, label: row.label, createdAt: row.created_at, expiresAt: row.expires_at, path };
}

export function viewCookieName(id: string): string {
  return `texlite_view_${id.replaceAll("-", "")}`;
}

/** Called on EVERY resource request, including Range/HEAD; never grants a UserRow. */
export function requireViewLink(db: DatabaseConnection, request: FastifyRequest, token?: unknown): ViewLinkRow {
  const { linkId } = request.params as { linkId: string };
  if (!/^[a-f0-9-]{36}$/i.test(linkId)) throw httpError(410, "VIEW_LINK_INVALID");
  const secret = token ?? request.cookies[viewCookieName(linkId)];
  if (typeof secret !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(secret)) throw httpError(410, "VIEW_LINK_INVALID");
  const row = db.prepare(`SELECT link.* FROM project_view_links link
    JOIN projects p ON p.id = link.project_id
    WHERE link.id = ? AND link.token_hash = ?
      AND (link.expires_at IS NULL OR link.expires_at > ?)`)
    .get(linkId, digestToken(secret), new Date().toISOString()) as ViewLinkRow | undefined;
  if (!row) throw httpError(410, "VIEW_LINK_INVALID");
  return row;
}
