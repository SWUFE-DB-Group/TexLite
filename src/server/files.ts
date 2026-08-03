import fs from "node:fs";
import path from "node:path";
import type { Config } from "./config.js";

export interface FileEntry {
  path: string;
  type: "file" | "directory";
  size?: number;
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

export function safeRelativePath(input: string): string {
  if (!input || input.includes("\0") || path.isAbsolute(input)) {
    throw new Error("无效的文件路径");
  }
  const normalized = path.posix.normalize(input.replaceAll("\\", "/"));
  if (normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw new Error("无效的文件路径");
  }
  if (normalized.split("/").some((segment) => segment.toLocaleLowerCase() === ".git")) {
    throw new Error(".git 是系统保留目录");
  }
  return normalized;
}

export function resolveSourcePath(config: Config, projectId: string, input: string): string {
  return path.join(sourceRoot(config, projectId), safeRelativePath(input));
}

export function listProjectFiles(config: Config, projectId: string): FileEntry[] {
  const root = sourceRoot(config, projectId);
  const result: FileEntry[] = [];
  const visit = (directory: string, prefix: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        result.push({ path: relative, type: "directory" });
        visit(absolute, relative);
      } else if (entry.isFile()) {
        result.push({ path: relative, type: "file", size: fs.statSync(absolute).size });
      }
    }
  };
  if (fs.existsSync(root)) visit(root, "");
  return result;
}

export function removeProjectDirectory(config: Config, projectId: string): void {
  const root = projectRoot(config, projectId);
  if (!fs.existsSync(root)) return;
  const trash = path.join(config.dataDir, "trash");
  fs.mkdirSync(trash, { recursive: true, mode: 0o700 });
  const target = path.join(trash, `${projectId}-${Date.now()}`);
  fs.renameSync(root, target);
  fs.rmSync(target, { recursive: true, force: true });
}
