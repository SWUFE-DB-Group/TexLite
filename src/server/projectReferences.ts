import fs from "node:fs";
import type { Config } from "./config.js";
import { listProjectFilesAsync, resolveSourcePath } from "./files.js";
import {
  findLatexReferenceDefinitions,
  lineAndColumnAt,
  type LatexReferenceKind
} from "../shared/latexReferences.js";
import {
  documentSourceOrder,
  latexDocumentDirectives,
  resolveProjectReferencePath,
  uniqueProjectPaths,
  type LatexDocumentDirectives
} from "./latexDocumentGraph.js";

export interface ProjectReferenceTarget {
  path: string;
  line: number;
  column: number;
  kind: LatexReferenceKind;
  source: "label" | "bibitem" | "bibtex";
  /**
   * Opaque version of the file that contains the definition. It changes
   * whenever that file's size or modification time does, so a client may reuse
   * data derived from the file for exactly as long as the value is unchanged.
   */
  revision: string;
}

export interface ProjectReferenceLookupOptions {
  /**
   * The file in which the user clicked. It has priority for local labels and
   * in-file bibliography entries.
   */
  preferredPath?: string;
  /**
   * The LaTeX root currently selected by this user. Its input graph and
   * declared bibliography resources define citation lookup precedence.
   */
  mainFile?: string;
}

const definitionExtensions = /\.(?:tex|sty|cls)$/i;
const texExtension = /\.tex$/i;
const bibExtension = /\.bib$/i;
const MAX_REFERENCE_KEY_LENGTH = 512;

interface CachedProjectSources {
  expiresAt: number;
  signature: string;
  contents: Map<string, string>;
  directives: Map<string, LatexDocumentDirectives>;
  bytes: number;
}

// Hover and navigation can resolve many keys from one project in quick
// succession. Cache the source snapshot by file metadata so different keys do
// not re-read and re-parse every LaTeX source inside the same short window.
const SOURCE_CACHE_TTL_MS = 15_000;
const MAX_SOURCE_CACHE_PROJECTS = 16;
const MAX_SOURCE_CACHE_BYTES = 8 * 1024 * 1024;
const MAX_SOURCE_CACHE_TOTAL_BYTES = 32 * 1024 * 1024;
const sourceCache = new Map<string, CachedProjectSources>();
let sourceCacheBytes = 0;
let sourceCacheSweep: ReturnType<typeof setTimeout> | null = null;

/** Resident size of the source-snapshot cache, for diagnostics and tests. */
export function projectReferenceCacheStats(): { projects: number; bytes: number } {
  return { projects: sourceCache.size, bytes: sourceCacheBytes };
}

function removeCachedSources(projectId: string): void {
  const removed = sourceCache.get(projectId);
  if (!removed) return;
  sourceCache.delete(projectId);
  sourceCacheBytes -= removed.bytes;
}

/**
 * The TTL only stops an entry from being reused; it does not free it. Without
 * a sweep, an idle project's sources would stay resident until another
 * project displaced them. One timer, aimed at the earliest expiry, releases
 * them on time and is not re-armed once the cache is empty. It is unref'd so
 * it never keeps the process alive.
 */
function scheduleSourceCacheSweep(): void {
  if (sourceCacheSweep !== null || sourceCache.size === 0) return;
  let earliest = Infinity;
  for (const entry of sourceCache.values()) earliest = Math.min(earliest, entry.expiresAt);
  sourceCacheSweep = setTimeout(() => {
    sourceCacheSweep = null;
    const now = Date.now();
    for (const [projectId, entry] of sourceCache) {
      if (entry.expiresAt <= now) removeCachedSources(projectId);
    }
    scheduleSourceCacheSweep();
  }, Math.max(0, earliest - Date.now()));
  sourceCacheSweep.unref();
}

export function validReferenceKey(value: unknown): value is string {
  return typeof value === "string"
    && value.trim().length > 0
    && value.trim().length <= MAX_REFERENCE_KEY_LENGTH
    && !/[\u0000-\u001f\u007f]/.test(value);
}

/**
 * Resolve a source-level citation or label target from the project tree.
 *
 * A document's own input graph and declared bibliography files are checked
 * before unrelated files in the project. This keeps a stale \bibitem in an
 * archive or template from shadowing the bibliography used by the selected
 * main document.
 */
export async function resolveProjectReference(
  config: Config,
  projectId: string,
  kind: LatexReferenceKind,
  keyInput: string,
  options: ProjectReferenceLookupOptions | string = {}
): Promise<ProjectReferenceTarget | null> {
  // Keep the former preferred-path argument working for internal callers
  // during the transition to the richer main-document-aware lookup options.
  const lookup = typeof options === "string" ? { preferredPath: options } : options;
  const key = keyInput.trim();
  const files = (await listProjectFilesAsync(config, projectId))
    .filter((entry) => entry.type === "file" && (definitionExtensions.test(entry.path) || bibExtension.test(entry.path)));
  const sourceEntries = files.filter((entry) => definitionExtensions.test(entry.path));
  const bibEntries = files.filter((entry) => bibExtension.test(entry.path));
  const { contents: sourceContents, directives: sourceDirectives } =
    await projectSourceSnapshot(config, projectId, sourceEntries);
  const sourcePaths = [...sourceContents.keys()].sort((left, right) => left.localeCompare(right));
  const bibPaths = bibEntries.map((entry) => entry.path).sort((left, right) => left.localeCompare(right));
  const revisions = new Map(files.map((entry) => [entry.path, `${entry.size ?? 0}:${entry.mtimeMs ?? 0}`]));

  const preferredPath = sourceContents.has(lookup.preferredPath ?? "") ? lookup.preferredPath ?? "" : "";
  const mainFile = sourceContents.has(lookup.mainFile ?? "") && texExtension.test(lookup.mainFile ?? "")
    ? lookup.mainFile ?? ""
    : "";
  const documentSources = documentSourceOrder(sourceDirectives, mainFile);
  const prioritizedSources = uniqueProjectPaths([
    ...(preferredPath ? [preferredPath] : []),
    ...documentSources
  ]);

  const orderedPaths = kind === "label"
    ? uniqueProjectPaths([...prioritizedSources, ...sourcePaths])
    : citationLookupOrder(sourceDirectives, prioritizedSources, bibPaths, sourcePaths);

  for (const entryPath of orderedPaths) {
    const source = sourceContents.get(entryPath)
      ?? await readProjectFile(config, projectId, entryPath);
    if (source === null) continue;
    const definition = findLatexReferenceDefinitions(source, kind, bibExtension.test(entryPath))
      .find((candidate) => candidate.key === key);
    if (!definition) continue;
    const location = lineAndColumnAt(source, definition.targetFrom);
    return { path: entryPath, ...location, kind, source: definition.source, revision: revisions.get(entryPath) ?? "" };
  }
  return null;
}

async function projectSourceSnapshot(
  config: Config,
  projectId: string,
  entries: ReadonlyArray<{ path: string; size?: number; mtimeMs?: number }>
): Promise<{ contents: Map<string, string>; directives: Map<string, LatexDocumentDirectives> }> {
  const signature = entries
    .map((entry) => `${entry.path}:${entry.size ?? 0}:${entry.mtimeMs ?? 0}`)
    .sort()
    .join("\n");
  const cached = sourceCache.get(projectId);
  if (cached && cached.expiresAt > Date.now() && cached.signature === signature) {
    // Refresh recency so an actively used project is evicted last.
    sourceCache.delete(projectId);
    sourceCache.set(projectId, cached);
    return cached;
  }

  const contents = await readProjectSources(config, projectId, entries.map((entry) => entry.path));
  const directives = new Map<string, LatexDocumentDirectives>();
  for (const [entryPath, source] of contents) directives.set(entryPath, latexDocumentDirectives(source));
  const bytes = [...contents.values()].reduce((total, source) => total + Buffer.byteLength(source, "utf8"), 0);
  removeCachedSources(projectId);
  if (bytes <= MAX_SOURCE_CACHE_BYTES) {
    sourceCache.set(projectId, {
      expiresAt: Date.now() + SOURCE_CACHE_TTL_MS, signature, contents, directives, bytes
    });
    sourceCacheBytes += bytes;
    while (sourceCache.size > MAX_SOURCE_CACHE_PROJECTS || sourceCacheBytes > MAX_SOURCE_CACHE_TOTAL_BYTES) {
      const oldest = sourceCache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      removeCachedSources(oldest);
    }
    scheduleSourceCacheSweep();
  }
  return { contents, directives };
}

async function readProjectSources(
  config: Config,
  projectId: string,
  paths: readonly string[]
): Promise<Map<string, string>> {
  const contents = new Map<string, string>();
  await Promise.all(paths.map(async (entryPath) => {
    const source = await readProjectFile(config, projectId, entryPath);
    if (source !== null) contents.set(entryPath, source);
  }));
  return contents;
}

async function readProjectFile(config: Config, projectId: string, entryPath: string): Promise<string | null> {
  try {
    return await fs.promises.readFile(resolveSourcePath(config, projectId, entryPath), "utf8");
  } catch (error) {
    // A concurrent file deletion is harmless for navigation. The project
    // mutation barrier prevents partial writes; simply continue to the next
    // possible definition when a file has disappeared.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function citationLookupOrder(
  sourceDirectives: ReadonlyMap<string, LatexDocumentDirectives>,
  documentSources: readonly string[],
  bibPaths: readonly string[],
  sourcePaths: readonly string[]
): string[] {
  // Callers without a selected root retain the conservative legacy behavior:
  // prefer in-source thebibliography entries before standalone .bib files.
  if (documentSources.length === 0) return uniqueProjectPaths([...sourcePaths, ...bibPaths]);
  const bibPathSet = new Set(bibPaths);
  const declaredBibliographies: string[] = [];
  for (const sourcePath of documentSources) {
    const directives = sourceDirectives.get(sourcePath);
    if (!directives) continue;
    for (const bibliography of directives.bibliographies) {
      const resolved = resolveProjectReferencePath(
        bibliography,
        sourcePath,
        ".bib",
        bibPathSet,
        "project-root-then-source-file"
      );
      if (resolved) declaredBibliographies.push(resolved);
    }
  }
  return uniqueProjectPaths([
    ...documentSources,
    ...declaredBibliographies,
    ...bibPaths,
    ...sourcePaths
  ]);
}
