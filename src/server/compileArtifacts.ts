import fs from "node:fs";
import path from "node:path";
import type { Config } from "./config.js";
import { publishedCompileArtifacts } from "./compiler.js";
import { outputRoot, resolveSourcePath, safeRelativePath, sourceRoot } from "./files.js";
import { hasDocumentClass } from "./zip.js";

export interface CompileArtifact {
  path: string;
  size: number;
  viewable: boolean;
}

export function availablePdf(
  config: Config,
  projectId: string,
  mainFile: string,
  defaultMainFile: string
): { path: string; version: string } | null {
  const isDefault = mainFile === defaultMainFile;
  const published = publishedCompileArtifacts(config, projectId, mainFile, isDefault);
  if (published) return { path: published.pdf, version: published.runId };
  if (!isDefault) return null;
  const retained = retainedPdfPath(config, projectId);
  if (fs.existsSync(retained)) return { path: retained, version: String(fs.statSync(retained).mtimeMs) };
  const legacy = path.join(outputRoot(config, projectId), `${path.basename(mainFile, ".tex")}.pdf`);
  return fs.existsSync(legacy) ? { path: legacy, version: String(fs.statSync(legacy).mtimeMs) } : null;
}

export function syncArtifacts(
  config: Config,
  projectId: string,
  mainFile: string,
  defaultMainFile: string
): { source: string; pdf: string; synctex: string } | null {
  const isDefault = mainFile === defaultMainFile;
  const published = publishedCompileArtifacts(config, projectId, mainFile, isDefault);
  if (published?.synctex) return { source: published.source, pdf: published.pdf, synctex: published.synctex };
  if (!isDefault) return null;
  const retained = {
    source: sourceRoot(config, projectId),
    pdf: retainedPdfPath(config, projectId),
    synctex: retainedSynctexPath(config, projectId)
  };
  if (fs.existsSync(retained.pdf) && fs.existsSync(retained.synctex)) return retained;
  const basename = path.basename(mainFile, ".tex");
  const legacy = {
    source: sourceRoot(config, projectId),
    pdf: path.join(outputRoot(config, projectId), `${basename}.pdf`),
    synctex: path.join(outputRoot(config, projectId), `${basename}.synctex.gz`)
  };
  return fs.existsSync(legacy.pdf) && fs.existsSync(legacy.synctex) ? legacy : null;
}

export function compileMainFile(
  config: Config,
  projectId: string,
  defaultMainFile: string,
  value: unknown
): string | null {
  let mainFile: string;
  try { mainFile = typeof value === "string" && value ? safeRelativePath(value) : defaultMainFile; }
  catch { return null; }
  if (!mainFile.toLocaleLowerCase().endsWith(".tex")) return null;
  const absolute = resolveSourcePath(config, projectId, mainFile);
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) return null;
  if (mainFile !== defaultMainFile && !hasDocumentClass(fs.readFileSync(absolute, "utf8"))) return null;
  return mainFile;
}

export function compilePdfUrl(projectId: string, mainFile: string, version: string): string {
  return `/api/projects/${projectId}/pdf?mainFile=${encodeURIComponent(mainFile)}&run=${encodeURIComponent(version)}`;
}

export function listCompileArtifacts(directory: string): CompileArtifact[] {
  const artifacts: CompileArtifact[] = [];
  const visit = (current: string, prefix: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) visit(absolute, relative);
      else if (entry.isFile()) {
        const size = fs.statSync(absolute).size;
        artifacts.push({ path: relative, size, viewable: size <= 2 * 1024 * 1024 && isTextCompileArtifact(relative) });
      }
    }
  };
  visit(directory, "");
  return artifacts.sort((left, right) => left.path.localeCompare(right.path));
}

export function isTextCompileArtifact(filePath: string): boolean {
  return /(?:\.aux|\.bbl|\.bcf|\.blg|\.fls|\.log|\.lof|\.lot|\.nav|\.out|\.run\.xml|\.snm|\.toc|\.vrb|\.fdb_latexmk)$/i.test(filePath);
}

function retainedPdfPath(config: Config, projectId: string): string {
  return path.join(outputRoot(config, projectId), ".texlite", "latest.pdf");
}

function retainedSynctexPath(config: Config, projectId: string): string {
  return path.join(outputRoot(config, projectId), ".texlite", "latest.synctex.gz");
}
