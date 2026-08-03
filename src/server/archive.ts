import fs from "node:fs";
import path from "node:path";
import { ZipFile } from "yazl";
import type { Config } from "./config.js";
import { sourceRoot } from "./files.js";

export function createProjectArchive(config: Config, projectId: string): ZipFile {
  const root = sourceRoot(config, projectId);
  const archive = new ZipFile();

  const addDirectory = (directory: string, prefix: string): void => {
    const entries = fs.readdirSync(directory, { withFileTypes: true });
    if (entries.length === 0 && prefix) archive.addEmptyDirectory(`${prefix}/`);
    for (const entry of entries) {
      if (entry.name === ".git" || entry.isSymbolicLink()) continue;
      const absolute = path.join(directory, entry.name);
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) addDirectory(absolute, relative);
      else if (entry.isFile()) archive.addFile(absolute, relative);
    }
  };

  addDirectory(root, "");
  archive.end();
  return archive;
}
