import type { FastifyRequest } from "fastify";

/** Cookie-authenticated WebSockets must originate from this deployment. */
export function browserOriginAllowed(request: FastifyRequest): boolean {
  const origin = request.headers.origin;
  if (!origin) return false;
  try {
    const parsed = new URL(origin);
    const forwarded = request.headers["x-forwarded-proto"];
    const protocol = forwarded === "https" || forwarded === "http" ? forwarded : request.protocol;
    return parsed.host === request.headers.host && parsed.protocol === `${protocol}:` && parsed.origin === origin;
  } catch { return false; }
}
