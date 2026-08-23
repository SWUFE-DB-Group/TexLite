import fs from "node:fs";
import type { Config } from "./config.js";
import { listProjectFiles, listProjectFilesAsync, resolveSourcePath, type FileEntry } from "./files.js";
import { hasDocumentClass } from "./zip.js";

interface RootDetectionCacheEntry {
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  result: boolean;
}

const rootDetectionCache = new Map<string, RootDetectionCacheEntry>();

export interface MainDocumentCandidates {
  texFiles: string[];
  mainFiles: string[];
}

function texFilePaths(files: FileEntry[]): string[] {
  return files
    .filter((entry) => entry.type === "file" && /\.tex$/i.test(entry.path))
    .map((entry) => entry.path)
    .sort((left, right) => left.localeCompare(right));
}

async function fileHasDocumentClass(config: Config, projectId: string, filePath: string): Promise<boolean> {
  try {
    const absolute = resolveSourcePath(config, projectId, filePath);
    const stat = await fs.promises.stat(absolute);
    const cached = rootDetectionCache.get(absolute);
    if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs && cached.ctimeMs === stat.ctimeMs) {
      return cached.result;
    }
    const result = hasDocumentClass(await fs.promises.readFile(absolute, "utf8"));
    cacheRootDetection(absolute, stat, result);
    return result;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function cacheRootDetection(absolute: string, stat: fs.Stats, result: boolean): void {
  if (rootDetectionCache.size >= 2_000 && !rootDetectionCache.has(absolute)) rootDetectionCache.clear();
  rootDetectionCache.set(absolute, { size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, result });
}

/**
 * Return selectable project roots. A single fragmentary .tex file remains a
 * compatibility fallback for imported projects; once a project contains more
 * than one .tex file, every candidate must declare \documentclass itself.
 */
export async function mainDocumentCandidates(
  config: Config,
  projectId: string,
  files?: FileEntry[]
): Promise<MainDocumentCandidates> {
  const texFiles = texFilePaths(files ?? await listProjectFilesAsync(config, projectId));
  const mainFiles: string[] = [];
  for (const filePath of texFiles) {
    if (await fileHasDocumentClass(config, projectId, filePath)) mainFiles.push(filePath);
  }
  return {
    texFiles,
    mainFiles: mainFiles.length > 0 ? mainFiles : texFiles.length === 1 ? texFiles : []
  };
}

export async function isMainDocumentCandidate(config: Config, projectId: string, filePath: string): Promise<boolean> {
  if (await fileHasDocumentClass(config, projectId, filePath)) return true;
  const texFiles = texFilePaths(await listProjectFilesAsync(config, projectId));
  return texFiles.length === 1 && texFiles[0] === filePath;
}

export function isMainDocumentCandidateSync(config: Config, projectId: string, filePath: string): boolean {
  try {
    const absolute = resolveSourcePath(config, projectId, filePath);
    const stat = fs.statSync(absolute);
    const cached = rootDetectionCache.get(absolute);
    if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs && cached.ctimeMs === stat.ctimeMs) {
      if (cached.result) return true;
    } else {
      const result = hasDocumentClass(fs.readFileSync(absolute, "utf8"));
      cacheRootDetection(absolute, stat, result);
      if (result) return true;
    }
  } catch {
    return false;
  }
  const texFiles = texFilePaths(listProjectFiles(config, projectId));
  return texFiles.length === 1 && texFiles[0] === filePath;
}
