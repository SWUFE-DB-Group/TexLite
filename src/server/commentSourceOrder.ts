import fs from "node:fs";
import { findLatexSourceIncludes } from "../shared/latexDependencies.js";
import { isTextContent } from "../shared/fileTypes.js";
import type { Config } from "./config.js";
import { listProjectFilesAsync, resolveSourcePath } from "./files.js";
import { isStaticLatexInclude, resolveLatexInclude, toLatexIncludeDirective } from "./latexDocumentGraph.js";

interface SourceComment {
  id: string;
  filePath: string;
  startOffset: number;
  startLine: number;
  createdAt: string;
}

// Match the outline's ordinary-source limits and bound total scan work too.
const MAX_SOURCE_FILES = 200;
const MAX_FILE_BYTES = 3 * 1024 * 1024;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;

/**
 * Interleave top-level discussions with statically included sources, following
 * the configured root rather than the current editor. This is a reading-order
 * hint, not TeX execution: repeated files use their first occurrence, and files
 * outside the graph (or the scan budget) retain deterministic fallback order.
 * The rank is response-only metadata; no anchors or database rows are changed.
 */
export async function sortProjectCommentsBySource<T extends SourceComment>(
  config: Config,
  projectId: string,
  mainFile: string,
  comments: readonly T[],
  sourceByPath: Map<string, string> = new Map()
): Promise<Array<T & { sourceOrder: number }>> {
  const fallback = [...comments].sort((a, b) =>
    a.filePath.localeCompare(b.filePath, "en", { numeric: true })
    || a.startOffset - b.startOffset || a.startLine - b.startLine
    || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  const byPath = new Map<string, T[]>();
  for (const comment of fallback) {
    const list = byPath.get(comment.filePath) ?? [];
    list.push(comment);
    byPath.set(comment.filePath, list);
  }
  // All notes in one file have the same relative order under any root.
  if (!mainFile || byPath.size < 2) return fallback.map((comment, sourceOrder) => ({ ...comment, sourceOrder }));

  const entries = await listProjectFilesAsync(config, projectId);
  const files = new Map(entries.filter((entry) => entry.type === "file").map((entry) => [entry.path, entry]));
  const ordered: T[] = [];
  const emitted = new Set<string>();
  const visited = new Set<string>();
  let scannedBytes = 0;
  const append = (comment: T) => { ordered.push(comment); emitted.add(comment.id); };
  const readSource = async (filePath: string): Promise<string | null> => {
    const size = files.get(filePath)?.size ?? 0;
    if (size > MAX_FILE_BYTES || scannedBytes + size > MAX_TOTAL_BYTES) return null;
    scannedBytes += size;
    if (sourceByPath.has(filePath)) return sourceByPath.get(filePath)!;
    try {
      const bytes = await fs.promises.readFile(resolveSourcePath(config, projectId, filePath));
      if (!isTextContent(bytes)) return null;
      const source = bytes.toString("utf8");
      sourceByPath.set(filePath, source);
      return source;
    } catch (error) {
      // A missing/unreadable source should not hide its existing discussions.
      if (!["ENOENT", "ENOTDIR", "EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      return null;
    }
  };
  const visit = async (filePath: string, importBase: string): Promise<void> => {
    if (!files.has(filePath) || visited.has(filePath) || visited.size >= MAX_SOURCE_FILES) return;
    visited.add(filePath);
    const source = await readSource(filePath);
    if (source === null) return;
    const local = byPath.get(filePath) ?? [];
    let index = 0;
    for (const reference of findLatexSourceIncludes(source)) {
      const directive = toLatexIncludeDirective(reference);
      if (!isStaticLatexInclude(directive)) continue;
      const included = resolveLatexInclude(directive, importBase, files);
      if (!included) continue;
      // A note on the include command/path itself precedes the included text.
      while (index < local.length && local[index].startOffset < reference.to) append(local[index++]);
      await visit(included.path, included.importBase);
    }
    while (index < local.length) append(local[index++]);
  };
  await visit(mainFile, "");
  for (const comment of fallback) if (!emitted.has(comment.id)) append(comment);
  return ordered.map((comment, sourceOrder) => ({ ...comment, sourceOrder }));
}
