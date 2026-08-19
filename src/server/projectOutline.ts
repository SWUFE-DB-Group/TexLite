import fs from "node:fs";
import path from "node:path";
import type { Config } from "./config.js";
import { listProjectFilesAsync, resolveSourcePath, safeRelativePath } from "./files.js";

export interface ProjectOutlineItem {
  path: string;
  line: number;
  level: number;
  title: string;
}

const levels: Record<string, number> = { part: 0, chapter: 0, section: 1, subsection: 2, subsubsection: 3, paragraph: 4 };
const commandPattern = /\\(part|chapter|section|subsection|subsubsection|paragraph)\*?(?:\s*\[[^\]]*\])?\s*\{|\\(?:input|include|subfile)\s*\{/g;

export function buildProjectOutline(config: Config, projectId: string, mainFileInput: string): ProjectOutlineItem[] {
  const mainFile = safeRelativePath(mainFileInput);
  const result: ProjectOutlineItem[] = [];
  const visited = new Set<string>();
  const visit = (filePath: string): void => {
    if (visited.has(filePath) || visited.size >= 200) return;
    visited.add(filePath);
    const absolute = resolveSourcePath(config, projectId, filePath);
    if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile() || fs.statSync(absolute).size > 3 * 1024 * 1024) return;
    const content = stripCommentsPreserveLines(fs.readFileSync(absolute, "utf8"));
    const lineStarts = sourceLineStarts(content);
    commandPattern.lastIndex = 0;
    for (const command of content.matchAll(commandPattern)) {
      const start = (command.index ?? 0) + command[0].length;
      const argument = balancedArgument(content, start);
      if (!argument) continue;
      if (command[1]) {
        result.push({ path: filePath, line: lineAtOffset(lineStarts, command.index ?? 0), level: levels[command[1]], title: cleanTitle(argument.value) });
        continue;
      }
      const included = resolveIncludedFile(config, projectId, filePath, argument.value);
      if (included) visit(included);
    }
  };
  visit(mainFile);
  return result;
}

/** Async outline builder used by the HTTP path so large projects do not block the event loop. */
export async function buildProjectOutlineAsync(config: Config, projectId: string, mainFileInput: string): Promise<ProjectOutlineItem[]> {
  const mainFile = safeRelativePath(mainFileInput);
  const result: ProjectOutlineItem[] = [];
  const visited = new Set<string>();
  const visit = async (filePath: string): Promise<void> => {
    if (visited.has(filePath) || visited.size >= 200) return;
    visited.add(filePath);
    let stat: fs.Stats;
    try { stat = await fs.promises.stat(resolveSourcePath(config, projectId, filePath)); }
    catch { return; }
    if (!stat.isFile() || stat.size > 3 * 1024 * 1024) return;
    let content: string;
    try { content = stripCommentsPreserveLines(await fs.promises.readFile(resolveSourcePath(config, projectId, filePath), "utf8")); }
    catch { return; }
    const lineStarts = sourceLineStarts(content);
    const pattern = new RegExp(commandPattern.source, commandPattern.flags);
    for (const command of content.matchAll(pattern)) {
      const start = (command.index ?? 0) + command[0].length;
      const argument = balancedArgument(content, start);
      if (!argument) continue;
      if (command[1]) {
        result.push({ path: filePath, line: lineAtOffset(lineStarts, command.index ?? 0), level: levels[command[1]], title: cleanTitle(argument.value) });
        continue;
      }
      const included = await resolveIncludedFileAsync(config, projectId, filePath, argument.value);
      if (included) await visit(included);
    }
  };
  await visit(mainFile);
  return result;
}

/**
 * Caches the parsed outline by project tree metadata and main document. The
 * pending map also coalesces simultaneous requests from multiple browser
 * sessions opening the same project.
 */
export class ProjectOutlineService {
  private readonly cache = new Map<string, { signature: string; outline: ProjectOutlineItem[]; touched: number }>();
  private readonly pending = new Map<string, Promise<ProjectOutlineItem[]>>();

  constructor(private readonly config: Config) {}

  build(projectId: string, mainFileInput: string): Promise<ProjectOutlineItem[]> {
    const mainFile = safeRelativePath(mainFileInput);
    const key = `${projectId}\0${mainFile}`;
    const existing = this.pending.get(key);
    if (existing) return existing;
    const request = this.buildCached(projectId, mainFile, key).finally(() => {
      if (this.pending.get(key) === request) this.pending.delete(key);
    });
    this.pending.set(key, request);
    return request;
  }

  invalidate(projectId: string): void {
    for (const key of this.cache.keys()) if (key.startsWith(`${projectId}\0`)) this.cache.delete(key);
  }

  stats(): { cachedOutlines: number; pending: number } {
    return { cachedOutlines: this.cache.size, pending: this.pending.size };
  }

  private async buildCached(projectId: string, mainFile: string, key: string): Promise<ProjectOutlineItem[]> {
    const entries = await listProjectFilesAsync(this.config, projectId);
    const signature = entries.map((entry) => `${entry.type}:${entry.path}:${entry.size ?? 0}:${entry.mtimeMs ?? 0}`).sort().join("\n");
    const cached = this.cache.get(key);
    if (cached?.signature === signature) {
      cached.touched = Date.now();
      return cached.outline;
    }
    const outline = await buildProjectOutlineAsync(this.config, projectId, mainFile);
    this.cache.set(key, { signature, outline, touched: Date.now() });
    if (this.cache.size > 64) {
      const oldest = [...this.cache.entries()].sort((left, right) => left[1].touched - right[1].touched)[0];
      if (oldest) this.cache.delete(oldest[0]);
    }
    return outline;
  }
}

function resolveIncludedFile(config: Config, projectId: string, currentFile: string, value: string): string | null {
  const raw = value.trim();
  if (!raw || /[\\#]/.test(raw)) return null;
  const withExtension = path.posix.extname(raw) ? raw : `${raw}.tex`;
  const candidates = [withExtension, path.posix.join(path.posix.dirname(currentFile), withExtension)];
  for (const candidate of [...new Set(candidates)]) {
    try {
      const safe = safeRelativePath(candidate);
      if (fs.existsSync(resolveSourcePath(config, projectId, safe))) return safe;
    } catch { /* Ignore includes outside the project. */ }
  }
  return null;
}

async function resolveIncludedFileAsync(config: Config, projectId: string, currentFile: string, value: string): Promise<string | null> {
  const raw = value.trim();
  if (!raw || /[\\#]/.test(raw)) return null;
  const withExtension = path.posix.extname(raw) ? raw : `${raw}.tex`;
  const candidates = [withExtension, path.posix.join(path.posix.dirname(currentFile), withExtension)];
  for (const candidate of [...new Set(candidates)]) {
    try {
      const safe = safeRelativePath(candidate);
      const stat = await fs.promises.stat(resolveSourcePath(config, projectId, safe));
      if (stat.isFile()) return safe;
    } catch { /* Ignore includes outside the project. */ }
  }
  return null;
}

function balancedArgument(source: string, start: number): { value: string; end: number } | null {
  let depth = 1;
  for (let index = start; index < source.length; index += 1) {
    if (source[index] === "{" && !escapedAt(source, index)) depth += 1;
    if (source[index] === "}" && !escapedAt(source, index)) depth -= 1;
    if (depth === 0) return { value: source.slice(start, index), end: index };
  }
  return null;
}

function stripCommentsPreserveLines(source: string): string {
  return source.split(/(?<=\n)/).map((line) => {
    for (let index = 0; index < line.length; index += 1) {
      if (line[index] === "%" && !escapedAt(line, index)) return `${line.slice(0, index)}${line.endsWith("\n") ? "\n" : ""}`;
    }
    return line;
  }).join("");
}

function escapedAt(source: string, index: number): boolean {
  let slashes = 0;
  for (let cursor = index - 1; cursor >= 0 && source[cursor] === "\\"; cursor -= 1) slashes += 1;
  return slashes % 2 === 1;
}

function sourceLineStarts(source: string): number[] {
  const starts = [0];
  for (let index = 0; index < source.length; index += 1) if (source[index] === "\n") starts.push(index + 1);
  return starts;
}

function lineAtOffset(starts: number[], offset: number): number {
  let low = 0;
  let high = starts.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (starts[middle] <= offset) low = middle + 1;
    else high = middle;
  }
  return Math.max(1, low);
}

function cleanTitle(value: string): string {
  return value.replace(/\\(?:texorpdfstring|MakeUppercase)\s*\{([^{}]*)\}(?:\{[^{}]*\})?/g, "$1").replace(/\\[a-zA-Z@]+\*?/g, "").replace(/[{}]/g, "").trim() || value.trim();
}
