import fs from "node:fs";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import yauzl, { type Entry, type ZipFile } from "yauzl";
import { assertNoSymbolicLinks, safeRelativePath } from "./files.js";

const MAX_ENTRIES = 1_000;
const MAX_TOTAL_BYTES = 200 * 1024 * 1024;

interface EntryInfo {
  fileName: string;
  uncompressedSize: number;
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

export async function extractProjectZip(buffer: Buffer, destination: string, maxFileBytes: number): Promise<ExtractedProject> {
  const maxTotalBytes = Math.max(MAX_TOTAL_BYTES, maxFileBytes);
  const entries = await inspectZip(buffer, maxFileBytes, maxTotalBytes);
  const prefix = commonRootPrefix(entries.filter((entry) => !entry.directory).map((entry) => entry.fileName));
  assertNoSymbolicLinks(destination);
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  const files = await extractZip(buffer, destination, prefix, maxFileBytes, maxTotalBytes);
  const mainFile = discoverMainFile(destination, files);
  if (!mainFile) throw new ZipValidationError("ZIP_MAIN_DOCUMENT_NOT_FOUND");
  return { files, mainFile };
}

async function inspectZip(buffer: Buffer, maxFileBytes: number, maxTotalBytes: number): Promise<EntryInfo[]> {
  const zip = await openZip(buffer);
  return await new Promise<EntryInfo[]>((resolve, reject) => {
    const entries: EntryInfo[] = [];
    const seenPaths = new Set<string>();
    let totalBytes = 0;
    const fail = (error: Error): void => { zip.close(); reject(error); };
    zip.on("error", reject);
    zip.on("entry", (entry: Entry) => {
      try {
        validateEntry(entry);
        if (entries.length >= MAX_ENTRIES) throw new ZipValidationError("ZIP_TOO_MANY_ENTRIES", { limit: MAX_ENTRIES });
        totalBytes += entry.uncompressedSize;
        if (entry.uncompressedSize > maxFileBytes) throw new ZipValidationError("ZIP_ENTRY_TOO_LARGE", { size: formatMB(maxFileBytes) });
        if (totalBytes > maxTotalBytes) throw new ZipValidationError("ZIP_TOTAL_TOO_LARGE", { size: formatMB(maxTotalBytes) });
        const normalized = normalizedEntryName(entry.fileName);
        // ZIP archives can contain duplicate entries.  Extraction of the
        // second entry would otherwise silently replace the first one (and a
        // `name`/`name/` pair would collide on disk as well).
        const collisionKey = safeRelativePath(normalized.replace(/\/+$/, ""));
        if (seenPaths.has(collisionKey)) throw new ZipValidationError("ZIP_DUPLICATE_ENTRY", { path: collisionKey });
        seenPaths.add(collisionKey);
        entries.push({ fileName: normalized, uncompressedSize: entry.uncompressedSize, directory: /\/$/.test(entry.fileName) });
        zip.readEntry();
      } catch (error) { fail(error instanceof Error ? error : new Error(String(error))); }
    });
    zip.on("end", () => resolve(entries));
    zip.readEntry();
  });
}

async function extractZip(
  buffer: Buffer,
  destination: string,
  prefix: string,
  maxFileBytes: number,
  maxTotalBytes: number
): Promise<string[]> {
  const zip = await openZip(buffer);
  return await new Promise<string[]>((resolve, reject) => {
    const files: string[] = [];
    let actualBytes = 0;
    let settled = false;
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      zip.close();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    zip.on("error", fail);
    zip.on("entry", (entry: Entry) => {
      void (async () => {
        validateEntry(entry);
        const normalized = normalizedEntryName(entry.fileName);
        const stripped = prefix && normalized.startsWith(prefix) ? normalized.slice(prefix.length) : normalized;
        if (!stripped || stripped.startsWith("__MACOSX/") || stripped.endsWith("/.DS_Store") || stripped === ".DS_Store") {
          zip.readEntry(); return;
        }
        const relative = safeRelativePath(stripped);
        const absolute = path.join(destination, relative);
        if (/\/$/.test(entry.fileName)) {
          fs.mkdirSync(absolute, { recursive: true, mode: 0o700 });
          zip.readEntry(); return;
        }
        fs.mkdirSync(path.dirname(absolute), { recursive: true, mode: 0o700 });
        const input = await openEntryStream(zip, entry);
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
        await pipeline(input, limiter, fs.createWriteStream(absolute, { mode: 0o600 }));
        files.push(relative);
        zip.readEntry();
      })().catch(fail);
    });
    zip.on("end", () => {
      if (!settled) { settled = true; resolve(files); }
    });
    zip.readEntry();
  });
}

function openZip(buffer: Buffer): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true, autoClose: true, strictFileNames: true, validateEntrySizes: true }, (error, zip) => {
      if (error || !zip) reject(new ZipValidationError("ZIP_READ_FAILED"));
      else resolve(zip);
    });
  });
}

function openEntryStream(zip: ZipFile, entry: Entry): Promise<NodeJS.ReadableStream> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error || !stream) reject(new ZipValidationError("ZIP_ENTRY_READ_FAILED"));
      else resolve(stream);
    });
  });
}

function validateEntry(entry: Entry): void {
  const name = entry.fileName;
  if (!name || name.includes("\0") || name.startsWith("/") || name.startsWith("\\")) throw new ZipValidationError("ZIP_INVALID_PATH");
  try {
    safeRelativePath(name.replace(/\/$/, "") || "invalid");
  } catch {
    throw new ZipValidationError("ZIP_INVALID_PATH");
  }
  const unixType = (entry.externalFileAttributes >>> 16) & 0o170000;
  if (unixType === 0o120000) throw new ZipValidationError("ZIP_SYMLINK_FORBIDDEN");
}

function normalizedEntryName(name: string): string {
  return name.replaceAll("\\", "/");
}

function commonRootPrefix(files: string[]): string {
  if (files.length === 0) return "";
  const first = files[0].split("/");
  if (first.length < 2 || !first[0]) return "";
  return files.every((file) => file.startsWith(`${first[0]}/`)) ? `${first[0]}/` : "";
}

function discoverMainFile(root: string, files: string[]): string {
  const texFiles = files.filter((file) => file.toLowerCase().endsWith(".tex"));
  if (texFiles.length === 1) return texFiles[0];
  return texFiles.find((file) => {
    const source = fs.readFileSync(path.join(root, file), "utf8");
    return hasDocumentClass(source);
  }) ?? "";
}

export function hasDocumentClass(source: string): boolean {
  const withoutComments = source.split(/(?<=\n)/).map((line) => {
    for (let index = 0; index < line.length; index += 1) {
      if (line[index] !== "%") continue;
      let slashes = 0;
      for (let cursor = index - 1; cursor >= 0 && line[cursor] === "\\"; cursor -= 1) slashes += 1;
      if (slashes % 2 === 0) return `${line.slice(0, index)}${line.endsWith("\n") ? "\n" : ""}`;
    }
    return line;
  }).join("");
  const withoutVerbatim = withoutComments
    .replace(/\\verb\*?([^\s]).*?\1/g, "")
    .replace(/\\begin\{(?:verbatim\*?|Verbatim|lstlisting|minted)\}(?:\[[^\]]*\])?[\s\S]*?\\end\{(?:verbatim\*?|Verbatim|lstlisting|minted)\}/g, "");
  return /\\documentclass\s*(?:\[[^\]]*\]\s*)?\{/.test(withoutVerbatim);
}

function formatMB(bytes: number): number {
  return Math.floor(bytes / 1024 / 1024);
}
