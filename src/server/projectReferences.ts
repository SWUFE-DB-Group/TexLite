import fs from "node:fs";
import type { Config } from "./config.js";
import { BoundedExpiringCache } from "./boundedExpiringCache.js";
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
   * Absent when the file's metadata is unknown: derived data must not be reused.
   */
  revision?: string;
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
  signature: string;
  contents: Map<string, string>;
  directives: Map<string, LatexDocumentDirectives>;
}

// Hover and navigation can resolve many keys from one project in quick
// succession. Cache the source snapshot by file metadata so different keys do
// not re-read and re-parse every LaTeX source inside the same short window.
const sourceCache = new BoundedExpiringCache<CachedProjectSources>({
  ttlMs: 15_000,
  maxEntries: 16,
  maxEntryBytes: 8 * 1024 * 1024,
  maxBytes: 32 * 1024 * 1024
});

interface BibliographyIndex {
  revision: string;
  /** First definition of each key, as navigation resolves duplicates. */
  locations: Map<string, { line: number; column: number }>;
}

// A .bib file can be several megabytes and every hover re-resolves its key.
// Keep only a key -> location index per file revision, not the content, so an
// unchanged bibliography is neither re-read nor re-scanned. Validity comes
// from the revision; the sliding lifetime only frees indexes nobody uses.
const bibliographyIndexCache = new BoundedExpiringCache<BibliographyIndex>({
  ttlMs: 5 * 60_000,
  refreshOnHit: true,
  maxEntries: 64,
  maxEntryBytes: 4 * 1024 * 1024,
  maxBytes: 16 * 1024 * 1024
});

/** Resident size of the source-snapshot cache, for diagnostics and tests. */
export function projectReferenceCacheStats(): { projects: number; bytes: number } {
  const { entries, bytes } = sourceCache.stats();
  return { projects: entries, bytes };
}

/** Resident size of the per-file bibliography index cache, for diagnostics and tests. */
export function bibliographyIndexCacheStats(): { files: number; bytes: number } {
  const { entries, bytes } = bibliographyIndexCache.stats();
  return { files: entries, bytes };
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
  // Without both size and mtime there is no trustworthy version; an empty
  // revision is omitted from the target and disables server-side caching.
  const revisions = new Map(files.map((entry) => [entry.path,
    entry.size === undefined || entry.mtimeMs === undefined ? "" : `${entry.size}:${entry.mtimeMs}`]));

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
    const revision = revisions.get(entryPath) ?? "";
    if (bibExtension.test(entryPath) && !sourceContents.has(entryPath)) {
      if (kind !== "citation") continue;
      const location = (await bibliographyIndex(config, projectId, entryPath, revision))?.get(key);
      if (!location) continue;
      return { path: entryPath, ...location, kind, source: "bibtex", ...(revision ? { revision } : {}) };
    }
    const source = sourceContents.get(entryPath)
      ?? await readProjectFile(config, projectId, entryPath);
    if (source === null) continue;
    const definition = findLatexReferenceDefinitions(source, kind, bibExtension.test(entryPath))
      .find((candidate) => candidate.key === key);
    if (!definition) continue;
    const location = lineAndColumnAt(source, definition.targetFrom);
    return { path: entryPath, ...location, kind, source: definition.source, ...(revision ? { revision } : {}) };
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
  if (cached?.signature === signature) return cached;

  const contents = await readProjectSources(config, projectId, entries.map((entry) => entry.path));
  const directives = new Map<string, LatexDocumentDirectives>();
  for (const [entryPath, source] of contents) directives.set(entryPath, latexDocumentDirectives(source));
  const bytes = [...contents.values()].reduce((total, source) => total + Buffer.byteLength(source, "utf8"), 0);
  sourceCache.set(projectId, { signature, contents, directives }, bytes);
  return { contents, directives };
}

/**
 * Key -> location index of one .bib file, reused while its revision is
 * unchanged. Returns null when the file has disappeared.
 */
async function bibliographyIndex(
  config: Config,
  projectId: string,
  entryPath: string,
  revision: string
): Promise<BibliographyIndex["locations"] | null> {
  const cacheKey = `${projectId}\0${entryPath}`;
  if (revision) {
    const cached = bibliographyIndexCache.get(cacheKey);
    if (cached?.revision === revision) return cached.locations;
  }
  const source = await readProjectFile(config, projectId, entryPath);
  if (source === null) {
    bibliographyIndexCache.delete(cacheKey);
    return null;
  }
  const locations: BibliographyIndex["locations"] = new Map();
  let bytes = 0;
  // Definitions arrive in source order, so one forward pass yields every line
  // and column instead of rescanning from the start for each entry.
  let line = 1;
  let lineStart = 0;
  let scanned = 0;
  for (const definition of findLatexReferenceDefinitions(source, "citation", true)) {
    if (locations.has(definition.key)) continue;
    let location: { line: number; column: number };
    if (definition.targetFrom < scanned) {
      location = lineAndColumnAt(source, definition.targetFrom);
    } else {
      const target = Math.min(definition.targetFrom, source.length);
      for (; scanned < target; scanned += 1) {
        if (source.charCodeAt(scanned) !== 10) continue;
        line += 1;
        lineStart = scanned + 1;
      }
      location = { line, column: target - lineStart + 1 };
    }
    locations.set(definition.key, location);
    bytes += definition.key.length * 2 + 64;
  }
  if (revision) bibliographyIndexCache.set(cacheKey, { revision, locations }, bytes);
  return locations;
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
