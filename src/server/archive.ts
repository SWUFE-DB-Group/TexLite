import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { ZipFile } from "yazl";
import type { Config } from "./config.js";
import { assertNoSourceSymlinks, sourceRoot, symbolicLinkError } from "./files.js";

export function createProjectArchive(config: Config, projectId: string): ZipFile {
  const root = sourceRoot(config, projectId);
  assertNoSourceSymlinks(config, projectId);
  const archive = new ZipFile();

  const addDirectory = (directory: string, prefix: string): void => {
    const entries = fs.readdirSync(directory, { withFileTypes: true });
    if (entries.length === 0 && prefix) archive.addEmptyDirectory(`${prefix}/`);
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw symbolicLinkError(relative);
      if (entry.name === ".git") continue;
      if (entry.isDirectory()) addDirectory(absolute, relative);
      else if (entry.isFile()) archive.addFile(absolute, relative);
    }
  };

  addDirectory(root, "");
  archive.end();
  return archive;
}

/**
 * Materialize an archive before releasing the project read lock.
 *
 * yazl reads added files asynchronously. Returning its output stream directly
 * from a route would therefore release the project lock while the ZIP is
 * still being assembled, allowing a concurrent write to produce a mixed
 * archive. Writing to a private temporary file makes the bytes immutable
 * before the caller starts the HTTP stream.
 */
export async function writeProjectArchive(
  config: Config,
  projectId: string,
  destination: string
): Promise<void> {
  const archive = createProjectArchive(config, projectId);
  await pipeline(archive.outputStream, fs.createWriteStream(destination, { mode: 0o600 }));
}
