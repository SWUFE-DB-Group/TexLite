import fs from "node:fs";
import path from "node:path";
import type { Config } from "./config.js";
import { resolveSourcePath, safeRelativePath } from "./files.js";

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
