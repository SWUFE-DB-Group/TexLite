import { normalizeBasePath, ROOT_BASE_PATH, withBasePath, withoutBasePath } from "../shared/basePath";

const metaName = "texlite-base-path";

function detectBasePath(): string {
  if (typeof document === "undefined") return ROOT_BASE_PATH;
  const declared = document.querySelector<HTMLMetaElement>(`meta[name="${metaName}"]`)?.content ?? ROOT_BASE_PATH;
  return normalizeBasePath(declared) ?? ROOT_BASE_PATH;
}

const detectedBasePath = detectBasePath();

export function currentBasePath(): string {
  return detectedBasePath;
}

/** Build an origin-local URL that remains inside this TexLite deployment. */
export function appPath(pathname: string, basePath = detectedBasePath): string {
  return withBasePath(basePath, pathname);
}

/** Return an application-relative pathname, or null for another mounted app. */
export function stripAppBasePath(pathname: string, basePath = detectedBasePath): string | null {
  return withoutBasePath(basePath, pathname);
}

/** Keep browser persistence isolated when several TexLite instances share an origin. */
export function scopedStorageKey(key: string, basePath = detectedBasePath): string {
  return basePath === ROOT_BASE_PATH ? key : `${key}:base=${encodeURIComponent(basePath)}`;
}
