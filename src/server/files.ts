import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Config } from "./config.js";
import { httpError, type HttpError } from "./http.js";

export interface FileEntry {
  path: string;
  type: "file" | "directory";
  size?: number;
  mtimeMs?: number;
}

export function projectRoot(config: Config, projectId: string): string {
  return path.join(config.projectsDir, projectId);
}

export function sourceRoot(config: Config, projectId: string): string {
  return path.join(projectRoot(config, projectId), "source");
}

export function outputRoot(config: Config, projectId: string): string {
  return path.join(projectRoot(config, projectId), "output");
}

export function createProjectFiles(config: Config, projectId: string): void {
  const source = sourceRoot(config, projectId);
  fs.mkdirSync(source, { recursive: true, mode: 0o700 });
  fs.mkdirSync(outputRoot(config, projectId), { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(source, "main.tex"),
    `\\documentclass{article}
\\title{New Project}
\\author{}
\\date{\\today}

\\begin{document}
\\maketitle

\\section{Introduction}
Start writing here.

\\end{document}
`,
    { encoding: "utf8", mode: 0o600 }
  );
}

export async function duplicateProjectFiles(config: Config, sourceProjectId: string, targetProjectId: string): Promise<void> {
  const source = sourceRoot(config, sourceProjectId);
  const target = sourceRoot(config, targetProjectId);
  assertNoSourceSymlinks(config, sourceProjectId);
  await fs.promises.mkdir(target, { recursive: true, mode: 0o700 });
  if (fs.existsSync(source)) {
    const entries = await fs.promises.readdir(source, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) throw symbolicLinkError(entry.name);
      if (isGitEntry(entry.name)) continue;
      await fs.promises.cp(path.join(source, entry.name), path.join(target, entry.name), {
        recursive: true, errorOnExist: true, force: false, verbatimSymlinks: false
      });
    }
  }
  await fs.promises.mkdir(outputRoot(config, targetProjectId), { recursive: true, mode: 0o700 });
}

const windowsDeviceName = /^(?:con|prn|aux|nul|conin\$|conout\$|(?:com|lpt)[1-9¹²³])$/i;

export function safeRelativePath(input: string, platform: NodeJS.Platform = process.platform): string {
  const windows = platform === "win32";
  if (!input || input.includes("\0") || (windows ? path.win32 : path.posix).isAbsolute(input)) {
    throw httpError(400, "INVALID_PATH");
  }
  const normalized = path.posix.normalize(input.replaceAll("\\", "/"));
  if (normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw httpError(400, "INVALID_PATH");
  }
  const segments = normalized.split("/");
  if (windows && segments.some((segment) => /^ |[\x00-\x1f<>:"|?*]|[. ]$/.test(segment)
    || windowsDeviceName.test(segment.split(".", 1)[0].replace(/ +$/, "")))) {
    throw httpError(400, "INVALID_PATH");
  }
  if (segments.some((segment) => (windows ? segment.toLowerCase() : segment.toLocaleLowerCase()) === ".git")) {
    throw httpError(400, "RESERVED_PATH");
  }
  return normalized;
}

/** Validate a user-provided file or directory name used within one folder. */
export function safePathSegment(input: string): string {
  const trimmed = input.trim();
  const name = process.platform === "win32" ? input : trimmed;
  if (!trimmed || name.includes("\0") || name.includes("/") || name.includes("\\")) {
    throw httpError(400, "INVALID_PATH");
  }
  return safeRelativePath(name);
}

export interface ResolveSourcePathOptions {
  /** Deletion is allowed to address the link itself, never its target. */
  allowFinalSymlink?: boolean;
  /** Only a case-only move may probe its destination using different casing. */
  allowFinalCaseAlias?: boolean;
}

function isGitEntry(name: string): boolean {
  return (process.platform === "win32" ? name.toLowerCase() : name) === ".git";
}

export function symbolicLinkError(relativePath: string): HttpError {
  return httpError(409, "SYMLINK_FORBIDDEN", { path: relativePath || "source" });
}

/**
 * Check every existing component below the project directory without
 * resolving it.  `stat()` and most file APIs follow links, so a lexical
 * `safeRelativePath()` check alone is not sufficient after a Git checkout.
 */
function assertSourcePathComponents(
  config: Config,
  projectId: string,
  relativePath: string,
  options: ResolveSourcePathOptions = {}
): void {
  let current = projectRoot(config, projectId);
  const segments = ["source", ...relativePath.split("/").filter(Boolean)];
  const projectStat = lstatIfPresent(current);
  if (projectStat?.isSymbolicLink()) throw symbolicLinkError("source");
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]);
    const stat = lstatIfPresent(current);
    if (!stat) return;
    const isFinal = index === segments.length - 1;
    if (stat.isSymbolicLink() && !(options.allowFinalSymlink && isFinal && relativePath.length > 0)) {
      const displayed = relativePath || segments.slice(0, index + 1).join("/");
      throw symbolicLinkError(displayed);
    }
    if (process.platform === "win32" && index > 0 && !stat.isSymbolicLink()) {
      const actualName = path.basename(fs.realpathSync.native(current));
      if (isGitEntry(actualName)) throw httpError(400, "RESERVED_PATH");
      const requestedName = segments[index];
      if (requestedName !== actualName && !(isFinal && options.allowFinalCaseAlias
        && requestedName.toLowerCase() === actualName.toLowerCase())) {
        // Do not let differently cased or DOS short aliases open separate
        // Yjs rooms, hold independent locks, or bypass reserved paths.
        throw httpError(400, "INVALID_PATH");
      }
    }
  }
}

function lstatIfPresent(target: string): fs.Stats | null {
  try { return fs.lstatSync(target); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** Reject every link below an existing directory without following it. */
export function assertNoSymbolicLinks(root: string, ignoreGitDirectory = false): void {
  const rootStat = lstatIfPresent(root);
  if (!rootStat) return;
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw symbolicLinkError("source");
  const visit = (directory: string, prefix: string): void => {
    const directoryStat = lstatIfPresent(directory);
    if (!directoryStat || directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
      throw symbolicLinkError(prefix || "source");
    }
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw symbolicLinkError(relative);
      if (ignoreGitDirectory && isGitEntry(entry.name)) continue;
      if (entry.isDirectory()) visit(path.join(directory, entry.name), relative);
    }
  };
  visit(root, "");
}

/** Reject every link in a checked-out project source tree. */
export function assertNoSourceSymlinks(config: Config, projectId: string): void {
  assertSourcePathComponents(config, projectId, "");
  assertNoSymbolicLinks(sourceRoot(config, projectId), true);
}

/** Return the output stem for a TeX file, regardless of extension casing. */
export function texFileStem(input: string): string {
  return path.basename(input).replace(/\.tex$/i, "");
}

export function resolveSourcePath(
  config: Config,
  projectId: string,
  input: string,
  options: ResolveSourcePathOptions = {}
): string {
  const relativePath = safeRelativePath(input);
  assertSourcePathComponents(config, projectId, relativePath, options);
  return path.join(sourceRoot(config, projectId), relativePath);
}

export function resolveProjectMoveDestination(
  config: Config, projectId: string, source: string, destination: string
): string {
  const caseOnly = process.platform === "win32" && source !== destination
    && path.posix.dirname(source) === path.posix.dirname(destination)
    && source.toLowerCase() === destination.toLowerCase();
  const target = resolveSourcePath(config, projectId, destination, { allowFinalCaseAlias: caseOnly });
  if (lstatIfPresent(target) && (!caseOnly || fs.realpathSync.native(target)
    !== fs.realpathSync.native(resolveSourcePath(config, projectId, source)))) {
    throw httpError(409, "PATH_EXISTS", { path: destination });
  }
  return target;
}

/** Surface sharing failures without falling back to non-atomic writes. */
export function renameProjectPath(source: string, destination: string): void {
  try { fs.renameSync(source, destination); }
  catch (error) {
    if (process.platform === "win32" && ["EBUSY", "EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) {
      throw httpError(409, "PROJECT_PATH_BUSY");
    }
    throw error;
  }
}

export function listProjectFiles(config: Config, projectId: string): FileEntry[] {
  const root = sourceRoot(config, projectId);
  const result: FileEntry[] = [];
  const visit = (directory: string, prefix: string): void => {
    const directoryStat = fs.lstatSync(directory);
    if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) throw symbolicLinkError(prefix || "source");
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw symbolicLinkError(relative);
      if (isGitEntry(entry.name)) continue;
      if (entry.isDirectory()) {
        result.push({ path: relative, type: "directory" });
        visit(absolute, relative);
      } else if (entry.isFile()) {
        const stat = fs.lstatSync(absolute);
        if (stat.isSymbolicLink()) throw symbolicLinkError(relative);
        if (stat.isFile()) result.push({ path: relative, type: "file", size: stat.size });
      }
    }
  };
  assertSourcePathComponents(config, projectId, "");
  if (lstatIfPresent(root)) visit(root, "");
  return result;
}

/** File-tree listings read metadata only; type detection belongs to path suffixes. */
export async function listProjectFilesAsync(config: Config, projectId: string): Promise<FileEntry[]> {
  const root = sourceRoot(config, projectId);
  const result: FileEntry[] = [];
  let activeIo = 0;
  const waiters: Array<() => void> = [];
  const limited = async <T>(operation: () => Promise<T>): Promise<T> => {
    if (activeIo >= 4) await new Promise<void>((resolve) => waiters.push(resolve));
    activeIo += 1;
    try { return await operation(); }
    finally {
      activeIo -= 1;
      waiters.shift()?.();
    }
  };
  const visit = async (directory: string, prefix: string): Promise<void> => {
    let entries: fs.Dirent[];
    try {
      const directoryStat = await limited(() => fs.promises.lstat(directory));
      if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) throw symbolicLinkError(prefix || "source");
      entries = await limited(() => fs.promises.readdir(directory, { withFileTypes: true }));
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const children: Promise<void>[] = [];
    for (const entry of entries) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw symbolicLinkError(relative);
      if (isGitEntry(entry.name)) continue;
      if (entry.isDirectory()) {
        result.push({ path: relative, type: "directory" });
        children.push(visit(absolute, relative));
      } else if (entry.isFile()) {
        try {
          const stat = await limited(() => fs.promises.lstat(absolute));
          if (stat.isSymbolicLink()) throw symbolicLinkError(relative);
          if (stat.isFile()) {
            result.push({ path: relative, type: "file", size: stat.size, mtimeMs: stat.mtimeMs });
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
    }
    await Promise.all(children);
  };
  assertSourcePathComponents(config, projectId, "");
  try { await visit(root, ""); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return result.sort((left, right) => left.path.localeCompare(right.path));
}

const trashRemovalOptions = {
  recursive: true, force: true,
  ...(process.platform === "win32" ? { maxRetries: 3, retryDelay: 100 } : {})
};

function trashDestination(config: Config, label: string): string {
  const trash = path.join(config.dataDir, "trash");
  fs.mkdirSync(trash, { recursive: true, mode: 0o700 });
  return path.join(trash, `${label}-${Date.now()}-${randomUUID()}`);
}

function retirePath(absolute: string, target: string): void {
  renameProjectPath(absolute, target);
  // If a handle is still open, the startup trash sweep retries it. The
  // retired path cannot partially disappear from the active source tree.
  void fs.promises.rm(target, trashRemovalOptions).catch(() => undefined);
}

export function removeProjectSourcePath(config: Config, absolute: string): void {
  if (process.platform === "win32") retirePath(absolute, trashDestination(config, "source"));
  else fs.rmSync(absolute, { recursive: true, force: true });
}

export function removeProjectDirectory(config: Config, projectId: string): void {
  const root = projectRoot(config, projectId);
  if (!lstatIfPresent(root)) return;
  const target = trashDestination(config, projectId);
  try {
    retirePath(root, target);
  } catch (error) {
    if (process.platform === "win32") throw error;
    fs.rmSync(root, { recursive: true, force: true });
    if (fs.existsSync(root)) {
      throw new Error(`Unable to remove project directory: ${root}`);
    }
  }
}

export async function pruneTrashDirectory(config: Config): Promise<void> {
  for (const folder of ["trash", "tmp"]) {
    const dir = path.join(config.dataDir, folder);
    try {
      if (!fs.existsSync(dir)) continue;
      const entries = await fs.promises.readdir(dir);
      await Promise.allSettled(entries.map((entry) => fs.promises.rm(path.join(dir, entry), trashRemovalOptions)));
    } catch {
      // Ignore error
    }
  }
}
