import fs from "node:fs";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { finished } from "node:stream/promises";
import { ZipWriter } from "@zip.js/zip.js/lib/zip-core-custom.js";
import type { Config } from "./config.js";
import { assertNoSourceSymlinks, sourceRoot, symbolicLinkError } from "./files.js";

/** Finish the ZIP in a private file before the caller releases its project lock. */
export async function writeProjectArchive(config: Config, projectId: string, destination: string): Promise<void> {
  const root = sourceRoot(config, projectId);
  assertNoSourceSymlinks(config, projectId);
  const output = fs.createWriteStream(destination, { mode: 0o600 });
  const archive = new ZipWriter(Writable.toWeb(output), {
    // Native Node >= 24 compression; sequential adds keep buffering bounded.
    useWebWorkers: false, useCompressionStream: true, bufferedWrite: false
  });

  const addDirectory = async (directory: string, prefix: string): Promise<void> => {
    const entries = await fs.promises.readdir(directory, { withFileTypes: true });
    if (entries.length === 0 && prefix) await archive.add(`${prefix}/`, undefined, { directory: true });
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw symbolicLinkError(relative);
      if (entry.name === ".git") continue;
      if (entry.isDirectory()) await addDirectory(absolute, relative);
      else if (entry.isFile()) {
        const stat = await fs.promises.stat(absolute);
        const input = fs.createReadStream(absolute);
        try {
          // Node and DOM declarations differ, but Node's adapter returns the
          // same native Web Stream that zip.js accepts at runtime.
          await archive.add(relative, Readable.toWeb(input) as ReadableStream<Uint8Array>, {
            lastModDate: stat.mtime, unixMode: stat.mode, uncompressedSize: stat.size
          });
        } finally {
          input.destroy();
        }
      }
    }
  };

  try {
    await addDirectory(root, "");
    await archive.close();
    await finished(output, { cleanup: true });
  } catch (error) {
    output.destroy();
    await finished(output, { cleanup: true }).catch(() => undefined);
    throw error;
  }
}
