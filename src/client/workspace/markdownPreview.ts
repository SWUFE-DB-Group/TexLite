import type { PreviewSurface } from "./types";

/** Files the workspace can show as rendered Markdown beside the source. */
export function isMarkdownPath(path: string): boolean {
  return /\.(?:md|markdown|mdown|mkdn)$/i.test(path);
}

/**
 * The preview surface to show. The document surface is the active Markdown
 * file's own preview when that is preferred, otherwise the PDF; compilation
 * and SyncTeX only choose between the document surface and diagnostics.
 */
export function displayedPreviewSurface(tab: Exclude<PreviewSurface, "markdown">, markdownActive: boolean, markdownPreferred: boolean): PreviewSurface {
  return tab === "diagnostics" ? "diagnostics" : markdownActive && markdownPreferred ? "markdown" : "pdf";
}

/** Where a link or image in a Markdown file points. */
export type MarkdownTarget =
  | { kind: "external" }
  | { kind: "anchor"; id: string }
  | { kind: "project"; path: string }
  | { kind: "invalid" };

/**
 * Resolve a URL from a Markdown file. Relative paths start at the file's
 * folder, and a leading `/` at the project root; paths that leave the project
 * are invalid rather than clamped, so a link never opens a different file.
 */
export function resolveMarkdownTarget(filePath: string, url: string): MarkdownTarget {
  if (url.startsWith("#")) return { kind: "anchor", id: safeDecode(url.slice(1)) };
  if (/^[a-z][a-z\d+.-]*:/i.test(url) || url.startsWith("//")) return { kind: "external" };
  const pathPart = url.replace(/[?#].*$/s, "");
  if (!pathPart) return { kind: "invalid" };
  const decoded = safeDecode(pathPart);
  const folder = filePath.includes("/") ? filePath.slice(0, filePath.lastIndexOf("/")).split("/") : [];
  const segments = decoded.startsWith("/") ? [] : [...folder];
  for (const segment of decoded.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (!segments.length) return { kind: "invalid" };
      segments.pop();
    } else segments.push(segment);
  }
  return segments.length ? { kind: "project", path: segments.join("/") } : { kind: "invalid" };
}

function safeDecode(value: string): string {
  try { return decodeURIComponent(value); } catch { return value; }
}

/** GitHub-style heading ids, so `[see](#getting-started)` reaches its heading. */
export function headingSlugs(titles: readonly string[]): string[] {
  const seen = new Map<string, number>();
  return titles.map((title) => {
    const base = title.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, "").replace(/\s/g, "-");
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return count ? `${base}-${count}` : base;
  });
}
