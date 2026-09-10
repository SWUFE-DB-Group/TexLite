export const ROOT_BASE_PATH = "/";

/**
 * Normalize a configured URL path prefix. Root is represented as `/`; every
 * other value starts with one slash and has no trailing slash.
 */
export function normalizeBasePath(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === ROOT_BASE_PATH) return ROOT_BASE_PATH;
  const normalized = trimmed.replace(/\/+$/, "");
  if (!normalized.startsWith("/") || normalized.includes("//")) return null;
  const segments = normalized.slice(1).split("/");
  if (!segments.length || segments.some((segment) => segment === "." || segment === ".." || !/^[A-Za-z0-9._~-]+$/.test(segment))) return null;
  return normalized;
}

/** Return the prefix used when registering or composing a path. */
export function basePathPrefix(basePath: string): string {
  return basePath === ROOT_BASE_PATH ? "" : basePath;
}

/** Prefix an origin-local absolute path with the configured application path. */
export function withBasePath(basePath: string, pathname: string): string {
  if (!pathname.startsWith("/")) throw new Error(`Application path must start with /: ${pathname}`);
  const prefix = basePathPrefix(basePath);
  if (!prefix) return pathname;
  return pathname === "/" ? `${prefix}/` : `${prefix}${pathname}`;
}

/** Remove the configured prefix, or return null when a path belongs elsewhere. */
export function withoutBasePath(basePath: string, pathname: string): string | null {
  const prefix = basePathPrefix(basePath);
  if (!prefix) return pathname;
  if (pathname === prefix || pathname === `${prefix}/`) return "/";
  if (!pathname.startsWith(`${prefix}/`)) return null;
  return pathname.slice(prefix.length) || "/";
}

export function basePathHref(basePath: string): string {
  return basePath === ROOT_BASE_PATH ? ROOT_BASE_PATH : `${basePath}/`;
}
