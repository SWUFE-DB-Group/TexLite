import fs from "node:fs";
import path from "node:path";
import type { Config } from "./config.js";
import { listProjectFilesAsync, resolveSourcePath } from "./files.js";
import {
  findLatexBibliographyFiles,
  findLatexReferenceDefinitions,
  findLatexSourceIncludes,
  lineAndColumnAt,
  type LatexReferenceKind
} from "../shared/latexReferences.js";

export interface ProjectReferenceTarget {
  path: string;
  line: number;
  column: number;
  kind: LatexReferenceKind;
  source: "label" | "bibitem" | "bibtex";
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
  const sourceContents = await readProjectSources(config, projectId, sourceEntries.map((entry) => entry.path));
  const sourcePaths = [...sourceContents.keys()].sort((left, right) => left.localeCompare(right));
  const bibPaths = bibEntries.map((entry) => entry.path).sort((left, right) => left.localeCompare(right));

  const preferredPath = sourceContents.has(lookup.preferredPath ?? "") ? lookup.preferredPath ?? "" : "";
  const mainFile = sourceContents.has(lookup.mainFile ?? "") && texExtension.test(lookup.mainFile ?? "")
    ? lookup.mainFile ?? ""
    : "";
  const documentSources = documentSourceOrder(sourceContents, mainFile);
  const prioritizedSources = uniquePaths([
    ...(preferredPath ? [preferredPath] : []),
    ...documentSources
  ]);

  const orderedPaths = kind === "label"
    ? uniquePaths([...prioritizedSources, ...sourcePaths])
    : citationLookupOrder(sourceContents, prioritizedSources, bibPaths, sourcePaths);

  for (const entryPath of orderedPaths) {
    const source = sourceContents.get(entryPath)
      ?? await readProjectFile(config, projectId, entryPath);
    if (source === null) continue;
    const definition = findLatexReferenceDefinitions(source, kind, bibExtension.test(entryPath))
      .find((candidate) => candidate.key === key);
    if (!definition) continue;
    const location = lineAndColumnAt(source, definition.targetFrom);
    return { path: entryPath, ...location, kind, source: definition.source };
  }
  return null;
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

function documentSourceOrder(contents: ReadonlyMap<string, string>, mainFile: string): string[] {
  if (!mainFile || !contents.has(mainFile)) return [];
  const result: string[] = [];
  const queued = [mainFile];
  const seen = new Set<string>();
  while (queued.length) {
    const current = queued.shift();
    if (!current || seen.has(current)) continue;
    const source = contents.get(current);
    if (source === undefined) continue;
    seen.add(current);
    result.push(current);
    for (const include of findLatexSourceIncludes(source)) {
      const resolved = resolveProjectReferencePath(include.path, current, ".tex", contents, false);
      if (resolved && !seen.has(resolved)) queued.push(resolved);
    }
  }
  return result;
}

function citationLookupOrder(
  sourceContents: ReadonlyMap<string, string>,
  documentSources: readonly string[],
  bibPaths: readonly string[],
  sourcePaths: readonly string[]
): string[] {
  // Callers without a selected root retain the conservative legacy behavior:
  // prefer in-source thebibliography entries before standalone .bib files.
  if (documentSources.length === 0) return uniquePaths([...sourcePaths, ...bibPaths]);
  const bibPathSet = new Set(bibPaths);
  const declaredBibliographies: string[] = [];
  for (const sourcePath of documentSources) {
    const source = sourceContents.get(sourcePath);
    if (source === undefined) continue;
    for (const bibliography of findLatexBibliographyFiles(source)) {
      const resolved = resolveProjectReferencePath(bibliography.path, sourcePath, ".bib", bibPathSet, true);
      if (resolved) declaredBibliographies.push(resolved);
    }
  }
  return uniquePaths([
    ...documentSources,
    ...declaredBibliographies,
    ...bibPaths,
    ...sourcePaths
  ]);
}

function resolveProjectReferencePath(
  rawPath: string,
  currentPath: string,
  extension: ".tex" | ".bib",
  available: ReadonlySet<string> | ReadonlyMap<string, unknown>,
  rootFirst: boolean
): string | null {
  const raw = normalizeReferenceInput(rawPath);
  if (!raw) return null;
  const parent = path.posix.dirname(currentPath);
  // TeX resolves relative files against the file that declared them. A raw
  // ../ reference is valid when this final candidate remains inside the
  // project tree (for example chapters/intro.tex -> ../refs.bib).
  const relative = normalizeProjectPath(parent === "." ? raw : path.posix.join(parent, raw));
  const root = normalizeProjectPath(raw);
  const roots = rootFirst ? [root, relative] : [relative, root];
  const candidates = roots.flatMap((candidate) => {
    if (!candidate) return [];
    return candidate.toLowerCase().endsWith(extension)
      ? [candidate]
      : [candidate, candidate + extension];
  });
  for (const candidate of uniquePaths(candidates)) {
    if (available.has(candidate)) return candidate;
  }
  return null;
}

function normalizeReferenceInput(value: string): string | null {
  const trimmed = value.trim().replaceAll("\\", "/");
  if (!trimmed || trimmed.startsWith("/") || /^[A-Za-z]:\//.test(trimmed) || trimmed.includes("\0")) return null;
  return trimmed;
}

function normalizeProjectPath(value: string): string | null {
  const normalized = path.posix.normalize(value);
  if (normalized === "." || normalized === ".." || normalized.startsWith("../")) return null;
  if (normalized.split("/").some((segment) => segment.toLowerCase() === ".git")) return null;
  return normalized;
}

function uniquePaths(paths: readonly string[]): string[] {
  const seen = new Set<string>();
  return paths.filter((entryPath) => {
    if (!entryPath || seen.has(entryPath)) return false;
    seen.add(entryPath);
    return true;
  });
}
