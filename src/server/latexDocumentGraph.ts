import path from "node:path";
import {
  findLatexBibliographyFiles,
  findLatexSourceIncludes,
  type LatexPathReference
} from "../shared/latexDependencies.js";

/** The path-bearing directives needed to follow one LaTeX document graph. */
export interface LatexDocumentDirectives {
  includes: readonly LatexIncludeDirective[];
  bibliographies: readonly string[];
}

export interface LatexIncludeDirective {
  path: string;
  command: string;
  /** The first argument of an import-package directive. */
  directory?: string;
}

export interface ResolvedLatexInclude {
  path: string;
  /** Active import.sty base for directives in the resolved source. */
  importBase: string;
}

type ProjectReferenceResolution = "project-root" | "source-file" | "project-root-then-source-file";

/**
 * Extract only the small amount of source information needed for project-level
 * document graph lookups. Keeping this separate from completion symbols means
 * cached completion data does not need to retain whole source files.
 */
export function latexDocumentDirectives(source: string): LatexDocumentDirectives {
  return {
    includes: findLatexSourceIncludes(source).map(toLatexIncludeDirective),
    bibliographies: findLatexBibliographyFiles(source).map((reference) => reference.path)
  };
}

export function toLatexIncludeDirective(reference: LatexPathReference): LatexIncludeDirective {
  return {
    path: reference.path,
    command: reference.command,
    ...(reference.directory === undefined ? {} : { directory: reference.directory })
  };
}

/** Reading-order consumers cannot expand macros or parameterized TeX paths. */
export function isStaticLatexInclude(directive: LatexIncludeDirective): boolean {
  return !/[\\#]/.test(directive.path)
    && (directive.directory === undefined || !/[\\#]/.test(directive.directory));
}

/** Return the selected root followed by its reachable \input-style sources. */
export function documentSourceOrder(
  sources: ReadonlyMap<string, LatexDocumentDirectives>,
  mainFile: string
): string[] {
  if (!mainFile || !sources.has(mainFile)) return [];
  const result: string[] = [];
  const queued: Array<{ path: string; importBase: string }> = [{ path: mainFile, importBase: "" }];
  // A source can technically be reached under more than one import context.
  // Keeping its first discovered context mirrors the ordinary project graph
  // traversal while bounding recursive import-package structures.
  const seen = new Set<string>();
  while (queued.length) {
    const current = queued.shift();
    if (!current || seen.has(current.path)) continue;
    const directives = sources.get(current.path);
    if (!directives) continue;
    seen.add(current.path);
    result.push(current.path);
    for (const include of directives.includes) {
      const resolved = resolveLatexInclude(include, current.importBase, sources);
      if (resolved && !seen.has(resolved.path)) queued.push(resolved);
    }
  }
  return result;
}

/**
 * Return exactly the BibTeX resources declared by a selected root and its
 * input graph. `null` means the selected root was unavailable to the graph
 * scanner, so callers can retain a backwards-compatible fallback.
 */
export function declaredBibliographyPaths(
  sources: ReadonlyMap<string, LatexDocumentDirectives>,
  mainFile: string,
  bibPaths: readonly string[]
): string[] | null {
  if (!mainFile || !sources.has(mainFile)) return null;
  const availableBibliographies = new Set(bibPaths);
  const declared: string[] = [];
  for (const sourcePath of documentSourceOrder(sources, mainFile)) {
    const directives = sources.get(sourcePath);
    if (!directives) continue;
    for (const bibliography of directives.bibliographies) {
      const resolved = resolveProjectReferencePath(
        bibliography,
        sourcePath,
        ".bib",
        availableBibliographies,
        "project-root-then-source-file"
      );
      if (resolved) declared.push(resolved);
    }
  }
  return uniqueProjectPaths(declared);
}

export function resolveProjectReferencePath(
  rawPath: string,
  currentPath: string,
  extension: ".tex" | ".bib",
  available: ReadonlySet<string> | ReadonlyMap<string, unknown>,
  resolution: ProjectReferenceResolution
): string | null {
  const raw = normalizeReferenceInput(rawPath);
  if (!raw) return null;
  const parent = path.posix.dirname(currentPath);
  const relative = normalizeProjectPath(parent === "." ? raw : path.posix.join(parent, raw));
  const root = normalizeProjectPath(raw);
  const roots = resolution === "project-root"
    ? [root]
    : resolution === "source-file"
      ? [relative]
      : [root, relative];
  return resolveCandidatePaths(roots, extension, available);
}

/**
 * Resolve import.sty's dynamic path handling.  `\\import`, `\\inputfrom`,
 * and `\\includefrom` reset the import path from the compiler root. Their
 * `sub*` counterparts extend the active path. Plain input-style commands use
 * the active path first, then the compiler root, matching import.sty's
 * `\\input@path` fallback behavior.
 */
export function resolveLatexInclude(
  include: LatexIncludeDirective,
  importBase: string,
  available: ReadonlySet<string> | ReadonlyMap<string, unknown>
): ResolvedLatexInclude | null {
  switch (include.command.toLowerCase()) {
    case "input":
    case "include": {
      const resolved = resolveOrdinaryIncludePath(include.path, importBase, available);
      return resolved ? { path: resolved, importBase } : null;
    }
    case "subfile":
      return resolveSubfilePath(include.path, importBase, available);
    case "import":
    case "includefrom":
    case "inputfrom": {
      const nextImportBase = normalizeImportBase(include.directory ?? "");
      if (nextImportBase === null) return null;
      const resolved = resolveProjectPathAtBase(include.path, "", ".tex", available);
      return resolved ? { path: resolved, importBase: nextImportBase } : null;
    }
    case "subimport":
    case "subinputfrom":
    case "subincludefrom": {
      const nextImportBase = extendImportBase(importBase, include.directory ?? "");
      if (nextImportBase === null) return null;
      const resolved = resolveProjectPathAtBase(include.path, importBase, ".tex", available);
      return resolved ? { path: resolved, importBase: nextImportBase } : null;
    }
    default:
      return null;
  }
}

/** `subfiles` implements \subfile through import.sty's \subimport. */
function resolveSubfilePath(
  rawPath: string,
  importBase: string,
  available: ReadonlySet<string> | ReadonlyMap<string, unknown>
): { path: string; importBase: string } | null {
  const raw = normalizeReferenceInput(rawPath);
  if (!raw) return null;
  const directory = path.posix.dirname(raw);
  const file = path.posix.basename(raw);
  if (!file || file === "." || file === "/") return null;
  const nextImportBase = extendImportBase(importBase, directory === "." ? "" : directory);
  if (nextImportBase === null) return null;
  const resolved = resolveProjectPathAtBase(file, nextImportBase, ".tex", available);
  return resolved ? { path: resolved, importBase: nextImportBase } : null;
}

function resolveOrdinaryIncludePath(
  rawPath: string,
  importBase: string,
  available: ReadonlySet<string> | ReadonlyMap<string, unknown>
): string | null {
  if (importBase) {
    const fromImportPath = resolveProjectPathAtBase(rawPath, importBase, ".tex", available);
    if (fromImportPath) return fromImportPath;
  }
  return resolveProjectPathAtBase(rawPath, "", ".tex", available);
}

function resolveProjectPathAtBase(
  rawPath: string,
  base: string,
  extension: ".tex" | ".bib",
  available: ReadonlySet<string> | ReadonlyMap<string, unknown>
): string | null {
  const raw = normalizeReferenceInput(rawPath);
  const normalizedBase = normalizeImportBase(base);
  if (!raw || normalizedBase === null) return null;
  const candidate = normalizeProjectPath(normalizedBase ? path.posix.join(normalizedBase, raw) : raw);
  return resolveCandidatePaths(candidate ? [candidate] : [], extension, available);
}

function extendImportBase(importBase: string, extension: string): string | null {
  const normalizedBase = normalizeImportBase(importBase);
  const relativeExtension = normalizeRelativeImportPath(extension);
  if (normalizedBase === null || relativeExtension === null) return null;
  return normalizeImportBase(normalizedBase
    ? path.posix.join(normalizedBase, relativeExtension)
    : relativeExtension);
}

function resolveCandidatePaths(
  paths: readonly (string | null)[],
  extension: ".tex" | ".bib",
  available: ReadonlySet<string> | ReadonlyMap<string, unknown>
): string | null {
  const candidates = paths.flatMap((candidate) => {
    if (!candidate) return [];
    return candidate.toLowerCase().endsWith(extension)
      ? [candidate]
      : [candidate, candidate + extension];
  });
  for (const candidate of uniqueProjectPaths(candidates)) {
    if (available.has(candidate)) return candidate;
  }
  return null;
}

export function uniqueProjectPaths(paths: readonly string[]): string[] {
  const seen = new Set<string>();
  return paths.filter((entryPath) => {
    if (!entryPath || seen.has(entryPath)) return false;
    seen.add(entryPath);
    return true;
  });
}

function normalizeReferenceInput(value: string): string | null {
  const trimmed = value.trim().replaceAll("\\", "/");
  if (!trimmed || trimmed.startsWith("/") || /^[A-Za-z]:\//.test(trimmed) || trimmed.includes("\0")) return null;
  return trimmed;
}

function normalizeRelativeImportPath(value: string): string | null {
  const trimmed = value.trim().replaceAll("\\", "/");
  if (trimmed.startsWith("/") || /^[A-Za-z]:\//.test(trimmed) || trimmed.includes("\0")) return null;
  return trimmed || ".";
}

function normalizeImportBase(value: string): string | null {
  const relative = normalizeRelativeImportPath(value);
  if (relative === null) return null;
  const normalized = path.posix.normalize(relative);
  if (normalized === ".") return "";
  if (normalized === ".." || normalized.startsWith("../")) return null;
  if (normalized.split("/").some((segment) => segment.toLowerCase() === ".git")) return null;
  return normalized;
}

function normalizeProjectPath(value: string): string | null {
  const normalized = path.posix.normalize(value);
  if (normalized === "." || normalized === ".." || normalized.startsWith("../")) return null;
  if (normalized.split("/").some((segment) => segment.toLowerCase() === ".git")) return null;
  return normalized;
}
