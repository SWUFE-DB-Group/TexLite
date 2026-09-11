import path from "node:path";
import { findLatexBibliographyFiles, findLatexSourceIncludes } from "../shared/latexReferences.js";

/** The path-bearing directives needed to follow one LaTeX document graph. */
export interface LatexDocumentDirectives {
  includes: readonly string[];
  bibliographies: readonly string[];
}

/**
 * Extract only the small amount of source information needed for project-level
 * document graph lookups. Keeping this separate from completion symbols means
 * cached completion data does not need to retain whole source files.
 */
export function latexDocumentDirectives(source: string): LatexDocumentDirectives {
  return {
    includes: findLatexSourceIncludes(source).map((reference) => reference.path),
    bibliographies: findLatexBibliographyFiles(source).map((reference) => reference.path)
  };
}

/** Return the selected root followed by its reachable \input-style sources. */
export function documentSourceOrder(
  sources: ReadonlyMap<string, LatexDocumentDirectives>,
  mainFile: string
): string[] {
  if (!mainFile || !sources.has(mainFile)) return [];
  const result: string[] = [];
  const queued = [mainFile];
  const seen = new Set<string>();
  while (queued.length) {
    const current = queued.shift();
    if (!current || seen.has(current)) continue;
    const directives = sources.get(current);
    if (!directives) continue;
    seen.add(current);
    result.push(current);
    for (const include of directives.includes) {
      const resolved = resolveProjectReferencePath(include, current, ".tex", sources, false);
      if (resolved && !seen.has(resolved)) queued.push(resolved);
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
      const resolved = resolveProjectReferencePath(bibliography, sourcePath, ".bib", availableBibliographies, true);
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

function normalizeProjectPath(value: string): string | null {
  const normalized = path.posix.normalize(value);
  if (normalized === "." || normalized === ".." || normalized.startsWith("../")) return null;
  if (normalized.split("/").some((segment) => segment.toLowerCase() === ".git")) return null;
  return normalized;
}
