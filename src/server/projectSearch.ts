import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { isTextContent, resourceFileKind } from "../shared/fileTypes.js";
import { PROJECT_SEARCH_MAX_MATCHES, type ProjectSearchOptions, type ProjectSearchResult } from "../shared/projectSearch.js";
import type { Config } from "./config.js";
import { maxCollaborativeFileBytes } from "./collaboration.js";
import { listProjectFilesAsync, resolveSourcePath } from "./files.js";

const maxFiles = 500;
const maxTotalBytes = 32 * 1024 * 1024;

/** Literal patterns only: arbitrary user regex must not block the server's event loop. */
export function searchPattern(options: ProjectSearchOptions): RegExp {
  const literal = options.query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = options.wholeWord ? `(?<![\\p{L}\\p{N}_])${literal}(?![\\p{L}\\p{N}_])` : literal;
  return new RegExp(pattern, options.caseSensitive ? "gu" : "giu");
}

/** The caller holds a consistent-read barrier so collaborative buffers are flushed first. */
export async function searchProject(config: Config, projectId: string, options: ProjectSearchOptions): Promise<ProjectSearchResult> {
  const candidates = (await listProjectFilesAsync(config, projectId))
    .filter((entry) => entry.type === "file" && resourceFileKind(entry.path) === "text")
    .sort((a, b) => a.path.localeCompare(b.path));
  const result: ProjectSearchResult = { matches: [], limited: candidates.length > maxFiles };
  const pattern = searchPattern(options);
  const fileLimit = Math.min(maxCollaborativeFileBytes(config), maxTotalBytes);
  let totalBytes = 0;
  for (const entry of candidates.slice(0, maxFiles)) {
    if ((entry.size ?? 0) > fileLimit || totalBytes + (entry.size ?? 0) > maxTotalBytes) { result.limited = true; continue; }
    let bytes: Buffer;
    try { bytes = await fs.readFile(resolveSourcePath(config, projectId, entry.path)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      result.limited = true;
      continue;
    }
    totalBytes += bytes.length;
    if (bytes.length > fileLimit || totalBytes > maxTotalBytes) { result.limited = true; continue; }
    if (!isTextContent(bytes)) continue;
    const content = bytes.toString("utf8");
    const sourceHash = createHash("sha256").update(content, "utf8").digest("hex");
    let line = 1, lineStart = 0, nextBreak = content.indexOf("\n");
    pattern.lastIndex = 0;
    for (const match of content.matchAll(pattern)) {
      if (result.matches.length >= PROJECT_SEARCH_MAX_MATCHES) { result.limited = true; return result; }
      const offset = match.index;
      while (nextBreak >= 0 && nextBreak < offset) {
        line++; lineStart = nextBreak + 1; nextBreak = content.indexOf("\n", lineStart);
      }
      const end = nextBreak;
      const lineEnd = end < 0 ? content.length : content[end - 1] === "\r" ? end - 1 : end;
      const from = Math.max(lineStart, offset - 80), to = Math.min(lineEnd, offset + match[0].length + 100);
      const prefix = from > lineStart ? "…" : "";
      const start = prefix.length + offset - from;
      result.matches.push({ path: entry.path, line, column: offset - lineStart + 1, sourceHash, from: offset, to: offset + match[0].length,
        preview: prefix + content.slice(from, to) + (to < lineEnd ? "…" : ""),
        matchStart: start, matchEnd: start + match[0].length });
    }
  }
  return result;
}
