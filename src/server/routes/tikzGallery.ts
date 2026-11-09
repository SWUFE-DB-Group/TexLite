import fs from "node:fs";
import type { FastifyInstance } from "fastify";
import { requireUser } from "../auth.js";
import type { Config } from "../config.js";
import type { DatabaseConnection } from "../db.js";
import { apiError } from "../http.js";
import { TikzGalleryLibrary } from "../tikzGallery.js";

/** A preview comes from a repository this host only chose, not wrote: opened directly, it must not run as TexLite. */
const SVG_CSP = "default-src 'none'; style-src 'unsafe-inline'; sandbox";

export function registerTikzGalleryRoutes(app: FastifyInstance, { config, db }: { config: Config; db: DatabaseConnection }): void {
  const library = new TikzGalleryLibrary(config.tikzGalleryDir);

  app.get("/api/tikz-gallery/catalog", async (request, reply) => {
    if (!requireUser(request, reply, db)) return;
    if (!config.tikzGalleryEnabled) return apiError(reply, 404, "TIKZ_GALLERY_DISABLED");
    const result = library.catalog();
    if (result.status === "unavailable") return apiError(reply, 503, "TIKZ_GALLERY_UNAVAILABLE");
    if (result.status === "incompatible") return apiError(reply, 409, "TIKZ_GALLERY_INCOMPATIBLE");
    reply.header("Cache-Control", "no-store");
    return result.catalog;
  });

  app.get("/api/tikz-gallery/file", async (request, reply) => {
    if (!requireUser(request, reply, db)) return;
    if (!config.tikzGalleryEnabled) return apiError(reply, 404, "TIKZ_GALLERY_DISABLED");
    const { path: relative } = request.query as { path?: string };
    const file = typeof relative === "string" ? library.listedFile(relative) : null;
    if (!file) return apiError(reply, 404, "FILE_NOT_FOUND");
    reply.header("Cache-Control", "private, max-age=300").header("X-Content-Type-Options", "nosniff");
    if (/\.svg$/i.test(file)) reply.header("Content-Security-Policy", SVG_CSP).type("image/svg+xml");
    else reply.type("text/plain; charset=utf-8");
    return reply.send(fs.readFileSync(file));
  });
}
