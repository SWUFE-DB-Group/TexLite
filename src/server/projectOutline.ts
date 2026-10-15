import fs from "node:fs";
import { maskLatexComments } from "../shared/latexLiterals.js";
import { findLatexSourceIncludes } from "../shared/latexDependencies.js";
import { forEachLatexCommand, readLatexMandatoryArguments } from "../shared/latexScanner.js";
import type { Config } from "./config.js";
import { resolveLatexInclude, toLatexIncludeDirective, type LatexIncludeDirective } from "./latexDocumentGraph.js";
import { listProjectFilesAsync, resolveSourcePath, safeRelativePath, type FileEntry } from "./files.js";

export interface ProjectOutlineItem {
  path: string;
  line: number;
  level: number;
  title: string;
}

const levels = new Map<string, number>([
  ["part", 0],
  ["chapter", 0],
  ["section", 1],
  ["subsection", 2],
  ["subsubsection", 3],
  ["paragraph", 4]
]);

type OutlineSourceEvent =
  | { type: "heading"; from: number; line: number; level: number; title: string }
  | { type: "include"; from: number; directive: LatexIncludeDirective };

async function buildProjectOutlineAsyncFromFiles(
  config: Config,
  projectId: string,
  mainFile: string,
  availableFiles: ReadonlySet<string>
): Promise<ProjectOutlineItem[]> {
  const result: ProjectOutlineItem[] = [];
  const visited = new Set<string>();
  const visit = async (filePath: string, importBase: string): Promise<void> => {
    if (visited.has(filePath) || visited.size >= 200) return;
    visited.add(filePath);
    let stat: fs.Stats;
    try { stat = await fs.promises.stat(resolveSourcePath(config, projectId, filePath)); }
    catch { return; }
    if (!stat.isFile() || stat.size > 3 * 1024 * 1024) return;
    let content: string;
    try { content = await fs.promises.readFile(resolveSourcePath(config, projectId, filePath), "utf8"); }
    catch { return; }
    for (const event of scanOutlineSource(content)) {
      if (event.type === "heading") {
        result.push({ path: filePath, line: event.line, level: event.level, title: event.title });
        continue;
      }
      const included = resolveLatexInclude(event.directive, importBase, availableFiles);
      if (included) await visit(included.path, included.importBase);
    }
  };
  await visit(mainFile, "");
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
    const outline = await buildProjectOutlineAsyncFromFiles(
      this.config,
      projectId,
      mainFile,
      sourceFilePaths(entries)
    );
    this.cache.set(key, { signature, outline, touched: Date.now() });
    if (this.cache.size > 64) {
      const oldest = [...this.cache.entries()].sort((left, right) => left[1].touched - right[1].touched)[0];
      if (oldest) this.cache.delete(oldest[0]);
    }
    return outline;
  }
}

function sourceFilePaths(entries: readonly FileEntry[]): Set<string> {
  return new Set(entries.filter((entry) => entry.type === "file").map((entry) => entry.path));
}

/**
 * Read one source file into ordered heading and include events. The shared
 * scanner preserves original source offsets while skipping comments and
 * literal TeX forms.
 */
function scanOutlineSource(source: string): OutlineSourceEvent[] {
  const lineStarts = sourceLineStarts(source);
  const events: OutlineSourceEvent[] = [];
  forEachLatexCommand(source, (command) => {
    const level = levels.get(command.name);
    if (level === undefined) return;
    const argument = readLatexMandatoryArguments(source, command.to, 1)[0];
    if (!argument) return;
    const value = source.slice(argument.contentFrom, argument.contentTo);
    events.push({
      type: "heading",
      from: command.from,
      line: lineAtOffset(lineStarts, command.from),
      level,
      title: cleanTitle(maskLatexComments(value))
    });
  });
  for (const reference of findLatexSourceIncludes(source)) {
    const directive = toLatexIncludeDirective(reference);
    if (!isStaticOutlineInclude(directive)) continue;
    events.push({
      type: "include",
      from: reference.from,
      directive
    });
  }
  return events.sort((left, right) => {
    if (left.from !== right.from) return left.from - right.from;
    if (left.type === right.type) return 0;
    return left.type === "heading" ? -1 : 1;
  });
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
  const cleaned = value
    .replace(/\\(?:texorpdfstring|MakeUppercase)\s*\{([^{}]*)\}(?:\{[^{}]*\})?/g, "$1")
    .replace(/\\[a-zA-Z@]+\*?/g, "")
    .replace(/[{}]/g, "");
  return compactOutlineWhitespace(cleaned) || compactOutlineWhitespace(value);
}

/**
 * `maskLatexComments` intentionally keeps source offsets intact, so a long
 * comment becomes a long run of spaces. Outline titles are display-only: keep
 * their original line breaks but collapse that offset-preserving padding.
 */
function compactOutlineWhitespace(value: string): string {
  return value.replace(/[^\S\r\n]{2,}/g, " ").trim();
}

/**
 * TeX paths containing a command or parameter marker need macro expansion.
 * Do not guess their target while building an outline. The generic document
 * graph deliberately supports backslash-separated paths for other consumers,
 * while the legacy outline already skipped these dynamic forms.
 */
function isStaticOutlineInclude(directive: LatexIncludeDirective): boolean {
  return !/[\\#]/.test(directive.path)
    && (directive.directory === undefined || !/[\\#]/.test(directive.directory));
}
