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
  const sourceDirectives = new Map<string, LatexDocumentDirectives>();
  for (const [entryPath, source] of sourceContents) sourceDirectives.set(entryPath, latexDocumentDirectives(source));

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
      const resolved = resolveProjectReferencePath(bibliography, sourcePath, ".bib", bibPathSet, true);
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
