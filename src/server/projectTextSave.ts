import fs from "node:fs";
import path from "node:path";
import type { DatabaseConnection } from "./db.js";
import { renameProjectPath } from "./files.js";

/**
 * Stage outside the source tree. SQLite rolls back metadata if installation
 * fails; if COMMIT fails after installation, restore the old bytes instead.
 * The caller must hold the project write lock throughout this operation.
 */
export function saveProjectText(
  db: DatabaseConnection,
  outputDirectory: string,
  target: string,
  content: Uint8Array,
  previous: fs.Stats | undefined,
  updateMetadata: () => void,
  reportCleanupFailure: (error: unknown, directory: string) => void
): void {
  const stagingRoot = path.join(outputDirectory, ".texlite");
  fs.mkdirSync(stagingRoot, { recursive: true, mode: 0o700 });
  const staging = fs.mkdtempSync(path.join(stagingRoot, "source-save-"));
  const replacement = path.join(staging, "replacement");
  const backup = path.join(staging, "previous");
  let installed = false;
  let keepBackup = false;
  try {
    if (previous) fs.copyFileSync(target, backup);
    fs.writeFileSync(replacement, content, { mode: 0o600 });
    if (previous && process.platform !== "win32") fs.chmodSync(replacement, previous.mode & 0o777);
    db.transaction(() => {
      // A metadata error here does not touch the original file. Nothing
      // outside this synchronous transaction observes the uncommitted rows.
      updateMetadata();
      renameProjectPath(replacement, target);
      installed = true;
    }).immediate();
  } catch (error) {
    if (installed) {
      try {
        if (previous) renameProjectPath(backup, target);
        else fs.unlinkSync(target);
      } catch (rollbackError) {
        keepBackup = true;
        throw new AggregateError([error, rollbackError], `Could not roll back source save for ${target}; recovery directory: ${staging}`);
      }
    }
    throw error;
  } finally {
    if (!keepBackup) {
      try { fs.rmSync(staging, { recursive: true, force: true }); }
      catch (error) { reportCleanupFailure(error, staging); }
    }
  }
}
