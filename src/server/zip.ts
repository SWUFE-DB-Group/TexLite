import fs from "node:fs";
import path from "node:path";
import { Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { ZipReader, Uint8ArrayReader, type Entry } from "@zip.js/zip.js/lib/zip-core-custom.js";
import { hasLatexDocumentClass } from "../shared/latexRoot.js";
import { assertNoSymbolicLinks, safeRelativePath } from "./files.js";

const MAX_ENTRIES = 1_000;
const MAX_TOTAL_BYTES = 200 * 1024 * 1024;

interface EntryInfo {
  entry: Entry;
  fileName: string;
  directory: boolean;
}

export interface ExtractedProject {
  files: string[];
  mainFile: string;
}

/** A ZIP validation error whose stable code is safe to return from the API. */
export class ZipValidationError extends Error {
  constructor(
    readonly code: string,
    readonly details: Record<string, unknown> = {}
  ) {
    super(code);
    this.name = "ZipValidationError";
  }
}

export async function extractProjectZip(
  buffer: Buffer, destination: string, maxFileBytes: number, platform: NodeJS.Platform = process.platform
): Promise<ExtractedProject> {
  const maxTotalBytes = Math.max(MAX_TOTAL_BYTES, maxFileBytes);
  // Node >= 24 provides native deflate-raw streams. The custom entry point
  // avoids loading browser workers or WASM codecs in the server process.
  const zip = new ZipReader(new Uint8ArrayReader(buffer), {
    useWebWorkers: false, useCompressionStream: true, checkCrc32: true,
    // Validate paths below so API errors retain their stable application codes.
    filenameValidation: "tolerant"
  });
  try {
    const entries = await inspectZip(zip, maxFileBytes, maxTotalBytes, platform);
    const prefix = commonRootPrefix(entries.filter((entry) => !entry.directory).map((entry) => entry.fileName));
    const root = path.resolve(destination);
    assertNoSymbolicLinks(root);
    await fs.promises.mkdir(root, { recursive: true, mode: 0o700 });
    const files = await extractZip(entries, root, prefix, maxFileBytes, maxTotalBytes, platform);
    const mainFile = await discoverMainFile(root, files);
    if (!mainFile) throw new ZipValidationError("ZIP_MAIN_DOCUMENT_NOT_FOUND");
    return { files, mainFile };
  } finally {
    await zip.close();
  }
}

async function inspectZip(
  zip: ZipReader<Uint8Array>, maxFileBytes: number, maxTotalBytes: number, platform: NodeJS.Platform
): Promise<EntryInfo[]> {
  const entries: EntryInfo[] = [];
  const seenPaths = new Set<string>();
  const windowsRoot: Map<string, WindowsZipPath> | null = platform === "win32" ? new Map() : null;
  let totalBytes = 0;
  try {
    for await (const entry of zip.getEntriesGenerator()) {
      const normalized = validateEntry(entry, platform);
      if (entries.length >= MAX_ENTRIES) throw new ZipValidationError("ZIP_TOO_MANY_ENTRIES", { limit: MAX_ENTRIES });
      totalBytes += entry.uncompressedSize;
      if (entry.uncompressedSize > maxFileBytes) throw new ZipValidationError("ZIP_ENTRY_TOO_LARGE", { size: formatMB(maxFileBytes) });
      if (totalBytes > maxTotalBytes) throw new ZipValidationError("ZIP_TOTAL_TOO_LARGE", { size: formatMB(maxTotalBytes) });
      // Canonical paths also detect aliases such as `./main.tex` and `main.tex`.
      if (seenPaths.has(normalized)) throw new ZipValidationError("ZIP_DUPLICATE_ENTRY", { path: normalized });
      seenPaths.add(normalized);
      if (windowsRoot) registerWindowsZipPath(windowsRoot, normalized, entry.directory);
      entries.push({ entry, fileName: normalized, directory: entry.directory });
    }
  } catch (error) {
    if (error instanceof ZipValidationError) throw error;
    throw new ZipValidationError("ZIP_READ_FAILED");
  }
  return entries;
}

type WindowsZipPath = { name: string; children: Map<string, WindowsZipPath> | null };

/** Each implicit directory has one spelling and cannot also be a file. */
function registerWindowsZipPath(root: Map<string, WindowsZipPath>, relative: string, directory: boolean): void {
  const segments = relative.split("/");
  let siblings = root;
  for (const [index, name] of segments.entries()) {
    const isDirectory = directory || index < segments.length - 1;
    const key = name.toUpperCase();
    const existing = siblings.get(key);
    if (existing && (existing.name !== name || !isDirectory || !existing.children)) {
      throw new ZipValidationError("ZIP_PATH_CONFLICT", { path: relative });
    }
    const node = existing ?? { name, children: isDirectory ? new Map<string, WindowsZipPath>() : null };
    if (!existing) siblings.set(key, node);
    if (node.children) siblings = node.children;
  }
}

async function extractZip(
  entries: EntryInfo[],
  destination: string,
  prefix: string,
  maxFileBytes: number,
  maxTotalBytes: number,
  platform: NodeJS.Platform
): Promise<string[]> {
  const files: string[] = [];
  // Only this extraction owns the cache. Recursive mkdir also establishes
  // ancestors, including directories whose explicit ZIP entry arrives later.
  const createdDirectories = new Set<string>([destination]);
  const ensureDirectory = async (directory: string): Promise<void> => {
    if (createdDirectories.has(directory)) return;
    await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
    for (let current = directory; !createdDirectories.has(current); current = path.dirname(current)) {
      createdDirectories.add(current);
    }
  };
  let actualBytes = 0;
  for (const { entry, fileName } of entries) {
    // An explicit entry for the stripped top-level directory has no target.
    if (prefix && entry.directory && fileName === prefix.slice(0, -1)) continue;
    const stripped = prefix && fileName.startsWith(prefix) ? fileName.slice(prefix.length) : fileName;
    if (!stripped || stripped.startsWith("__MACOSX/") || stripped.endsWith("/.DS_Store") || stripped === ".DS_Store") continue;
    const relative = safeRelativePath(stripped, platform);
    const absolute = path.join(destination, relative);
    if (entry.directory) {
      await ensureDirectory(absolute);
      continue;
    }
    await ensureDirectory(path.dirname(absolute));
    let entryBytes = 0;
    const limiter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        actualBytes += chunk.length;
        entryBytes += chunk.length;
        if (entryBytes > maxFileBytes) callback(new ZipValidationError("ZIP_ENTRY_TOO_LARGE", { size: formatMB(maxFileBytes) }));
        else if (actualBytes > maxTotalBytes) callback(new ZipValidationError("ZIP_TOTAL_TOO_LARGE", { size: formatMB(maxTotalBytes) }));
        else callback(null, chunk);
      }
    });
    // Let the filesystem reject aliases not captured by lexical comparison.
    const writing = pipeline(limiter, fs.createWriteStream(absolute, { mode: 0o600, flags: platform === "win32" ? "wx" : "w" }));
    const extracting = entry.getData(Writable.toWeb(limiter));
    try {
      await Promise.all([extracting, writing]);
    } catch (error) {
      // getData can fail before it opens the writer (for example, encryption).
      // Destroy the bridge too, so no pending pipeline or file handle survives.
      limiter.destroy(error instanceof Error ? error : new Error(String(error)));
      await Promise.allSettled([extracting, writing]);
      if (error instanceof ZipValidationError) throw error;
      if (platform === "win32" && (error as NodeJS.ErrnoException)?.code === "EEXIST") {
        throw new ZipValidationError("ZIP_PATH_CONFLICT", { path: relative });
      }
      throw new ZipValidationError("ZIP_ENTRY_READ_FAILED");
    }
    files.push(relative);
  }
  return files;
}

function validateEntry(entry: Entry, platform: NodeJS.Platform): string {
  const name = entry.filename;
  if (!name || name.includes("\0") || name.startsWith("/") || name.includes("\\") || /^[a-z]:/i.test(name) || name.split("/").includes("..")) {
    throw new ZipValidationError("ZIP_INVALID_PATH");
  }
  let normalized: string;
  try {
    normalized = safeRelativePath(name.replace(/\/+$/, ""), platform);
  } catch {
    throw new ZipValidationError("ZIP_INVALID_PATH");
  }
  const unixType = (entry.externalFileAttributes >>> 16) & 0o170000;
  if (unixType === 0o120000) throw new ZipValidationError("ZIP_SYMLINK_FORBIDDEN");
  return normalized;
}

function commonRootPrefix(files: string[]): string {
  if (files.length === 0) return "";
  const first = files[0].split("/");
  if (first.length < 2 || !first[0]) return "";
  return files.every((file) => file.startsWith(`${first[0]}/`)) ? `${first[0]}/` : "";
}

async function discoverMainFile(root: string, files: string[]): Promise<string> {
  const texFiles = files.filter((file) => file.toLowerCase().endsWith(".tex"));
  if (texFiles.length === 1) return texFiles[0];
  for (const file of texFiles) {
    const source = await fs.promises.readFile(path.join(root, file), "utf8");
    if (hasDocumentClass(source)) return file;
  }
  return "";
}

export function hasDocumentClass(source: string): boolean {
  return hasLatexDocumentClass(source);
}

function formatMB(bytes: number): number {
  return Math.floor(bytes / 1024 / 1024);
}
