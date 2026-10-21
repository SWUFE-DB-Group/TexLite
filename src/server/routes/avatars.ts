import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { isAvatarStyle } from "../../shared/avatars.js";
import { publicUser, requireUser } from "../auth.js";
import { generateUserAvatar } from "../avatars.js";
import type { CollaborationService } from "../collaboration.js";
import type { DatabaseConnection, UserRow } from "../db.js";
import { apiError } from "../http.js";

export function registerAvatarRoutes(app: FastifyInstance, { db, collaboration }: {
  db: DatabaseConnection; collaboration: CollaborationService;
}): void {
  app.put("/api/me/avatar", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const style = (request.body as { style?: unknown } | null)?.style;
    if (style !== null && !isAvatarStyle(style)) return apiError(reply, 400, "AVATAR_STYLE_INVALID");
    // Generate before writing: a failed render must leave the previous avatar intact.
    const svg = style === null ? null : await generateUserAvatar(user.username, style);
    const updated = db.prepare("UPDATE users SET avatar_style = ?, avatar_svg = ? WHERE id = ? AND disabled = 0 RETURNING *")
      .get(style, svg, user.id) as UserRow | undefined;
    if (!updated) return apiError(reply, 401, "AUTH_REQUIRED");
    collaboration.updateUserAvatar(updated);
    return { user: publicUser(updated) };
  });

  app.get("/api/users/:id/avatar.svg", async (request, reply) => {
    const viewer = requireUser(request, reply, db);
    if (!viewer) return;
    const { id } = request.params as { id: string };
    const { style, preview } = request.query as { style?: unknown; preview?: string };
    const user = db.prepare("SELECT id, username, avatar_style, avatar_svg FROM users WHERE id = ?")
      .get(id) as Pick<UserRow, "id" | "username" | "avatar_style" | "avatar_svg"> | undefined;
    if (!user) return apiError(reply, 404, "USER_NOT_FOUND");
    let svg: string;
    if (preview === "1") {
      if (id !== viewer.id) return apiError(reply, 403, "AVATAR_PREVIEW_FORBIDDEN");
      if (!isAvatarStyle(style)) return apiError(reply, 400, "AVATAR_STYLE_INVALID");
      svg = await generateUserAvatar(user.username, style);
    } else {
      if (!isAvatarStyle(user.avatar_style) || (style !== undefined && style !== user.avatar_style)) {
        return apiError(reply, 404, "AVATAR_NOT_FOUND");
      }
      if (user.avatar_svg) svg = user.avatar_svg;
      else {
        // Upgrade the earlier style-only schema on first use, without changing
        // the user's saved style or generating every account's SVG at startup.
        svg = await generateUserAvatar(user.username, user.avatar_style);
        const result = db.prepare("UPDATE users SET avatar_svg = COALESCE(avatar_svg, ?) WHERE id = ? AND avatar_style = ? RETURNING avatar_svg")
          .get(svg, id, user.avatar_style) as { avatar_svg: string } | undefined;
        if (!result) return apiError(reply, 404, "AVATAR_NOT_FOUND");
        svg = result.avatar_svg;
      }
    }
    const etag = `"${createHash("sha256").update(svg).digest("hex")}"`;
    reply.header("Content-Type", "image/svg+xml; charset=utf-8")
      .header("X-Content-Type-Options", "nosniff")
      .header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox")
      .header("Cache-Control", style !== undefined ? "private, max-age=86400" : "private, no-cache")
      .header("ETag", etag);
    if (request.headers["if-none-match"]?.split(",").some((tag) => tag.trim().replace(/^W\//, "") === etag || tag.trim() === "*")) {
      return reply.code(304).send();
    }
    return reply.send(svg);
  });
}
