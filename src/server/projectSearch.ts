import fs from "node:fs";
import path from "node:path";
import type { Config } from "./config.js";
import { listProjectFilesAsync, resolveSourcePath } from "./files.js";

export interface ProjectSearchOptions {
  query: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  maxFileBytes?: number;
}

export interface ProjectSearchMatch {
  path: string;
  line: number;
  column: number;
  preview: string;
  matchStart: number;
  matchEnd: number;
}

const textExtension = /(?:\.(?:tex|bib|sty|cls|txt|md)|latexmkrc)$/i;
const maxFiles = 500;
const maxFileBytes = 3 * 1024 * 1024;
const maxTotalBytes = 24 * 1024 * 1024;
const maxMatches = 500;

export async function searchProject(config: Config, projectId: string, options: ProjectSearchOptions): Promise<{ matches: ProjectSearchMatch[]; total: number; truncated: boolean }> {
  const pattern = searchPattern(options);
  const matches: ProjectSearchMatch[] = [];
  let total = 0;
  let indexedBytes = 0;
  const entries = (await listProjectFilesAsync(config, projectId)).filter((entry) => entry.type === "file" && textExtension.test(entry.path)).slice(0, maxFiles);
  for (const entry of entries) {
    if ((entry.size ?? 0) > maxFileBytes || indexedBytes + (entry.size ?? 0) > maxTotalBytes) continue;
    indexedBytes += entry.size ?? 0;
    let content: string;
    try { content = await fs.promises.readFile(resolveSourcePath(config, projectId, entry.path), "utf8"); }
    catch { continue; }
    pattern.lastIndex = 0;
    let line = 1;
    let lineStart = 0;
    let nextLineBreak = content.indexOf("\n");
    for (const match of content.matchAll(pattern)) {
      total += 1;
      if (matches.length >= maxMatches) continue;
      const offset = match.index;
      while (nextLineBreak >= 0 && nextLineBreak < offset) {
        line += 1;
        lineStart = nextLineBreak + 1;
        nextLineBreak = content.indexOf("\n", lineStart);
      }
      const lineEndCandidate = content.indexOf("\n", offset);
      const lineEnd = lineEndCandidate < 0 ? content.length : lineEndCandidate;
      const preview = content.slice(lineStart, lineEnd).slice(0, 500);
      const previewOffset = Math.min(offset - lineStart, 500);
      matches.push({
        path: entry.path,
        line,
        column: offset - lineStart + 1,
        preview,
        matchStart: previewOffset,
        matchEnd: Math.min(preview.length, previewOffset + match[0].length)
      });
    }
  }
  return { matches, total, truncated: total > matches.length };
}

export async function replaceProject(config: Config, projectId: string, options: ProjectSearchOptions, replacement: string): Promise<Array<{ path: string; previous: string; content: string; count: number }>> {
  const pattern = searchPattern(options);
  const staged: Array<{ path: string; absolute: string; temporary: string; previous: string; content: string; count: number }> = [];
  let indexedBytes = 0;
  const entries = (await listProjectFilesAsync(config, projectId)).filter((entry) => entry.type === "file" && textExtension.test(entry.path)).slice(0, maxFiles);
  for (const entry of entries) {
    if ((entry.size ?? 0) > maxFileBytes || indexedBytes + (entry.size ?? 0) > maxTotalBytes) continue;
    indexedBytes += entry.size ?? 0;
    const absolute = resolveSourcePath(config, projectId, entry.path);
    let previous: string;
    try { previous = await fs.promises.readFile(absolute, "utf8"); }
    catch { continue; }
    pattern.lastIndex = 0;
    let count = 0;
    const content = previous.replace(pattern, () => { count += 1; return replacement; });
    if (!count || content === previous) continue;
    if (options.maxFileBytes !== undefined && Buffer.byteLength(content, "utf8") > options.maxFileBytes) {
      await Promise.allSettled(staged.map((entry) => fs.promises.rm(entry.temporary, { force: true })));
      throw Object.assign(new Error(`Replacement would exceed the ${Math.floor(options.maxFileBytes / 1024 / 1024)} MB collaborative text limit`), {
        code: "FILE_TOO_LARGE", statusCode: 413
      });
    }
    const temporary = `${absolute}.search-${process.pid}-${Date.now()}-${staged.length}.tmp`;
    await fs.promises.writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
    staged.push({ path: entry.path, absolute, temporary, previous, content, count });
  }
  const installed: typeof staged = [];
  try {
    for (const entry of staged) {
      await fs.promises.rename(entry.temporary, entry.absolute);
      installed.push(entry);
    }
  } catch (error) {
    // A project-wide replacement is presented as one operation. Restore every
    // file already installed if a later rename fails, and remove unused stages.
    for (const entry of installed.reverse()) {
      const rollback = `${entry.absolute}.search-rollback-${process.pid}-${Date.now()}.tmp`;
      await fs.promises.writeFile(rollback, entry.previous, { encoding: "utf8", mode: 0o600 });
      await fs.promises.rename(rollback, entry.absolute);
    }
    await Promise.allSettled(staged.map((entry) => fs.promises.rm(entry.temporary, { force: true })));
    throw error;
  }
  return staged.map(({ path: filePath, previous, content, count }) => ({ path: filePath, previous, content, count }));
}

function searchPattern(options: ProjectSearchOptions): RegExp {
  const query = options.query.trim();
  if (!query || query.length > 500) throw Object.assign(new Error("搜索内容格式不正确"), { code: "SEARCH_QUERY_INVALID", statusCode: 400 });
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const source = options.wholeWord ? `(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])` : escaped;
  return new RegExp(source, `${options.caseSensitive ? "" : "i"}gu`);
}

export function projectSearchTextFile(filePath: string): boolean {
  return textExtension.test(path.basename(filePath));
}
