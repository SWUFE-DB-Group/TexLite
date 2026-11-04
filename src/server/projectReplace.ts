import fs from "node:fs";
import { createHash } from "node:crypto";
import { isTextContent, resourceFileKind } from "../shared/fileTypes.js";
import { PROJECT_SEARCH_MAX_MATCHES, type ProjectReplaceTarget, type ProjectSearchOptions } from "../shared/projectSearch.js";
import { maxCollaborativeFileBytes } from "./collaboration.js";
import type { Config } from "./config.js";
import { resolveSourcePath } from "./files.js";
import { httpError } from "./http.js";
import { searchPattern } from "./projectSearch.js";

/** Prepare all files without yielding or writing. Hashes bind edits to the displayed results. */
export function prepareProjectReplacement(config: Config, projectId: string, options: ProjectSearchOptions,
  replacement: string, targets: readonly ProjectReplaceTarget[]) {
  let replaced = 0;
  let totalBytes = 0;
  const files = targets.map((target) => {
    if (resourceFileKind(target.path) !== "text") throw httpError(400, "FILE_CONTENT_INVALID");
    const absolute = resolveSourcePath(config, projectId, target.path);
    let bytes: Buffer;
    try {
      const stat = fs.statSync(absolute);
      if (!stat.isFile()) throw httpError(409, "SEARCH_SOURCE_CHANGED");
      totalBytes += stat.size;
      if (totalBytes > 32 * 1024 * 1024) throw httpError(409, "SEARCH_LIMITED");
      if (stat.size > maxCollaborativeFileBytes(config)) throw httpError(413, "FILE_TOO_LARGE");
      bytes = fs.readFileSync(absolute);
    } catch (error) {
      if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw httpError(409, "SEARCH_SOURCE_CHANGED");
      throw error;
    }
    if (!isTextContent(bytes)) throw httpError(400, "FILE_CONTENT_INVALID");
    if (createHash("sha256").update(bytes).digest("hex") !== target.sourceHash) throw httpError(409, "SEARCH_SOURCE_CHANGED");
    const before = bytes.toString("utf8");
    const ranges = new Map(target.ranges.map((range) => [range.from, range.to]));
    const matchedRanges = new Set<number>();
    const edits: { from: number; to: number; insert: string }[] = [];
    for (const match of before.matchAll(searchPattern(options))) {
      if (ranges.get(match.index) !== match.index + match[0].length) continue;
      matchedRanges.add(match.index);
      if (match[0] === replacement) continue;
      if (++replaced > PROJECT_SEARCH_MAX_MATCHES) throw httpError(409, "SEARCH_LIMITED");
      edits.push({ from: match.index, to: match.index + match[0].length, insert: replacement });
    }
    if (matchedRanges.size !== ranges.size) throw httpError(409, "SEARCH_SOURCE_CHANGED");
    const pieces: string[] = []; let offset = 0;
    for (const edit of edits) { pieces.push(before.slice(offset, edit.from), edit.insert); offset = edit.to; }
    pieces.push(before.slice(offset));
    const content = pieces.join("");
    if (Buffer.byteLength(content, "utf8") > maxCollaborativeFileBytes(config)) throw httpError(413, "FILE_TOO_LARGE");
    return { path: target.path, before, edits };
  }).filter((file) => file.edits.length > 0);
  return { files, replaced };
}
