import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { Config } from "./config.js";
import type { DatabaseConnection, ProjectRow } from "./db.js";
import { assertNoSourceSymlinks, listProjectFiles, outputRoot, projectRoot, resolveSourcePath, safeRelativePath, sourceRoot } from "./files.js";
import { httpError } from "./http.js";
import { MAX_TEXT_PREVIEW_BYTES } from "./limits.js";

export type HistoryReason = "initial" | "autosave" | "file" | "settings" | "git" | "restore" | "checkpoint";

interface HistoryFile {
  digest: string;
  size: number;
}

export interface HistoryManifest {
  version: 1;
  files: Record<string, HistoryFile>;
  settings: {
    mainFile: string;
    engine: ProjectRow["engine"];
    latexmkrc: string | null;
  };
}

interface HistoryRow {
  id: string;
  project_id: string;
  author_id: string | null;
  reason: HistoryReason;
  label: string | null;
  manifest_json: string;
  changed_paths_json: string;
  created_at: string;
}

export interface HistoryVersion {
  id: string;
  reason: HistoryReason;
  label: string | null;
  createdAt: string;
  author: { id: string; username: string; name: string } | null;
  changedPaths: string[];
  fileCount: number;
  totalSize: number;
}

export interface HistoryPage {
  versions: HistoryVersion[];
  /** Opaque cursor for the next older page, or null when the timeline ends. */
  nextCursor: string | null;
}

export interface HistoryStats {
  versionCount: number;
  ordinaryVersionCount: number;
  labeledVersionCount: number;
  objectCount: number;
  objectBytes: number;
  metadataBytes: number;
  totalBytes: number;
  protectedBytes: number;
  maxVersions: number;
  maxStorageBytes: number;
  storageLimitExceeded: boolean;
}

export interface HistoryRecordOptions {
  /**
   * Keep the durable version write in the caller's path, but defer expensive
   * retention work (manifest scans and object garbage collection).
   */
  deferRetention?: boolean;
}

const AUTOSAVE_COALESCE_MS = 2 * 60_000;
// Logical stored payload; SQLite pages, indexes and WAL are shared database overhead.
function historyMetadataBytes(row: HistoryRow): number {
  return Object.values(row).reduce<number>((sum, value) => sum + (typeof value === "string" ? Buffer.byteLength(value, "utf8") : 0), 0);
}
const DEFAULT_HISTORY_PAGE_SIZE = 100;
const MAX_HISTORY_PAGE_SIZE = 100;

interface HistoryCursor {
  createdAt: string;
  rowId: number;
}

type HistoryListRow = HistoryRow & {
  author_username: string | null;
  author_name: string | null;
};

type HistoryPageRow = HistoryListRow & { history_rowid: number };

export class ProjectHistoryService {
  constructor(private readonly config: Config, private readonly db: DatabaseConnection) {}

  record(
    projectId: string,
    authorId: string | null,
    reason: HistoryReason,
    changedRoots?: readonly string[],
    options: HistoryRecordOptions = {}
  ): HistoryVersion | null {
    const project = this.project(projectId);
    const previous = this.latestRow(projectId);
    const previousManifest = this.baseline(projectId) ?? (previous ? parseManifest(previous.manifest_json) : null);
    const manifest = previousManifest ? cloneManifest(previousManifest) : this.emptyManifest(project);
    manifest.settings = settings(project);

    if (!previousManifest || changedRoots === undefined) {
      manifest.files = this.snapshotAllFiles(projectId);
    } else {
      for (const rootInput of changedRoots) {
        const root = safeRelativePath(rootInput);
        for (const filePath of Object.keys(manifest.files)) {
          if (filePath === root || filePath.startsWith(`${root}/`)) delete manifest.files[filePath];
        }
        for (const [filePath, file] of Object.entries(this.snapshotPath(projectId, root))) manifest.files[filePath] = file;
      }
    }

    const changedPaths = previousManifest ? changedManifestPaths(previousManifest, manifest) : Object.keys(manifest.files).sort();
    if (previousManifest && changedPaths.length === 0 && JSON.stringify(previousManifest.settings) === JSON.stringify(manifest.settings)) {
      this.saveBaseline(projectId, manifest);
      return null;
    }

    const createdAt = new Date().toISOString();
    if (reason === "autosave" && previous?.reason === "autosave" && !previous.label
      && Date.parse(createdAt) - Date.parse(previous.created_at) < AUTOSAVE_COALESCE_MS) {
      const merged = [...new Set([...parseStringArray(previous.changed_paths_json), ...changedPaths])].sort();
      this.db.prepare(`UPDATE project_history_versions
        SET manifest_json = ?, changed_paths_json = ?, author_id = ? WHERE id = ?`)
        .run(JSON.stringify(manifest), JSON.stringify(merged), previous.author_id === authorId ? authorId : null, previous.id);
      this.saveBaseline(projectId, manifest);
      if (!options.deferRetention) {
        this.removeUnreferencedObjects(projectId, new Set(previousManifest
          ? Object.values(previousManifest.files).map((file) => file.digest)
          : []));
        this.pruneVersions(projectId);
      }
      return this.version(previous.id)!;
    }

    const id = randomUUID();
    this.db.prepare(`INSERT INTO project_history_versions
      (id, project_id, author_id, reason, manifest_json, changed_paths_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(id, projectId, authorId, reason, JSON.stringify(manifest), JSON.stringify(changedPaths), createdAt);
    this.saveBaseline(projectId, manifest);
    if (!options.deferRetention) this.pruneVersions(projectId);
    return this.version(id)!;
  }

  list(projectId: string, limit = 100): HistoryVersion[] {
    const rows = this.db.prepare(`SELECT history.*, user.username AS author_username, user.display_name AS author_name
      FROM project_history_versions history LEFT JOIN users user ON user.id = history.author_id
      WHERE history.project_id = ? ORDER BY history.created_at DESC, history.rowid DESC LIMIT ?`)
      .all(projectId, Math.min(200, Math.max(1, limit))) as HistoryListRow[];
    return rows.map((row) => versionJson(row));
  }

  /**
   * List immutable recovery snapshots from newest to oldest. Cursor pagination
   * is preferable to offsets here: concurrent saves/deletions cannot shift an
   * already loaded page or make the next request repeat a snapshot.
  */
  listPage(projectId: string, limit = DEFAULT_HISTORY_PAGE_SIZE, cursorInput?: string): HistoryPage {
    const requestedLimit = Number.isFinite(limit) ? Math.floor(limit) : DEFAULT_HISTORY_PAGE_SIZE;
    const limitValue = Math.min(MAX_HISTORY_PAGE_SIZE, Math.max(1, requestedLimit));
    const cursor = cursorInput === undefined ? null : decodeHistoryCursor(cursorInput);
    if (cursorInput !== undefined && !cursor) throw httpError(400, "REQUEST_INVALID");
    const values: Array<string | number> = [projectId];
    let cursorFilter = "";
    if (cursor) {
      cursorFilter = "AND (history.created_at < ? OR (history.created_at = ? AND history.rowid < ?))";
      values.push(cursor.createdAt, cursor.createdAt, cursor.rowId);
    }
    values.push(limitValue + 1);
    const rows = this.db.prepare(`SELECT history.*, history.rowid AS history_rowid,
      user.username AS author_username, user.display_name AS author_name
      FROM project_history_versions history LEFT JOIN users user ON user.id = history.author_id
      WHERE history.project_id = ? ${cursorFilter}
      ORDER BY history.created_at DESC, history.rowid DESC LIMIT ?`)
      .all(...values) as HistoryPageRow[];
    const pageRows = rows.slice(0, limitValue);
    return {
      versions: pageRows.map((row) => versionJson(row)),
      nextCursor: rows.length > limitValue && pageRows.length > 0 ? encodeHistoryCursor(pageRows.at(-1)!) : null
    };
  }

  stats(projectId: string): HistoryStats {
    const rows = this.db.prepare(`SELECT * FROM project_history_versions
      WHERE project_id = ? ORDER BY created_at DESC, rowid DESC`).all(projectId) as HistoryRow[];
    const objects = new Map<string, number>();
    const protectedObjects = new Map<string, number>();
    let metadataBytes = 0;
    let protectedMetadataBytes = 0;
    let ordinaryVersionCount = 0;
    let labeledVersionCount = 0;
    for (const row of rows) {
      const protectedVersion = row === rows[0] || row.reason === "initial" || Boolean(row.label);
      metadataBytes += historyMetadataBytes(row);
      if (protectedVersion) protectedMetadataBytes += historyMetadataBytes(row);
      if (row.label) labeledVersionCount += 1;
      else if (row.reason !== "initial") ordinaryVersionCount += 1;
      for (const file of Object.values(parseManifest(row.manifest_json).files)) {
        if (!objects.has(file.digest)) objects.set(file.digest, file.size);
        if (protectedVersion) protectedObjects.set(file.digest, file.size);
      }
    }
    const baseline = this.baseline(projectId);
    if (baseline) {
      const baselineBytes = Buffer.byteLength(JSON.stringify(baseline), "utf8");
      metadataBytes += baselineBytes;
      protectedMetadataBytes += baselineBytes;
      for (const file of Object.values(baseline.files)) {
        if (!objects.has(file.digest)) objects.set(file.digest, file.size);
        protectedObjects.set(file.digest, file.size);
      }
    }
    const objectBytes = [...objects.values()].reduce((sum, size) => sum + size, 0);
    return {
      versionCount: rows.length,
      ordinaryVersionCount,
      labeledVersionCount,
      objectCount: objects.size,
      objectBytes,
      metadataBytes,
      totalBytes: objectBytes + metadataBytes,
      protectedBytes: [...protectedObjects.values()].reduce((sum, size) => sum + size, protectedMetadataBytes),
      maxVersions: this.config.historyMaxVersions,
      maxStorageBytes: this.config.historyMaxStorageBytes,
      storageLimitExceeded: objectBytes + metadataBytes > this.config.historyMaxStorageBytes
    };
  }

  enforceRetention(projectId: string): void {
    this.pruneVersions(projectId);
    // Deferred autosave maintenance can leave an object from a coalesced
    // version without any manifest referring to it. Scan the small
    // content-addressed object store here (never in the save path) so a
    // restart also recovers objects left behind before a timer could run.
    this.removeUnreferencedObjects(projectId, this.storedObjectDigests(projectId));
  }

  deleteVersion(projectId: string, versionId: string): boolean {
    const row = this.db.prepare("SELECT id, manifest_json FROM project_history_versions WHERE id = ? AND project_id = ?")
      .get(versionId, projectId) as { id: string; manifest_json: string } | undefined;
    if (!row) return false;
    this.saveBaseline(projectId, this.snapshotCurrent(projectId));
    this.deleteVersions(projectId, [row]);
    return true;
  }

  clear(projectId: string): void {
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM project_history_state WHERE project_id = ?").run(projectId);
      this.db.prepare("DELETE FROM project_history_versions WHERE project_id = ?").run(projectId);
    })();
    fs.rmSync(path.join(outputRoot(this.config, projectId), ".texlite", "history"), { recursive: true, force: true });
  }

  version(id: string, projectId?: string): HistoryVersion | null {
    const row = this.db.prepare(`SELECT history.*, user.username AS author_username, user.display_name AS author_name
      FROM project_history_versions history LEFT JOIN users user ON user.id = history.author_id
      WHERE history.id = ? ${projectId ? "AND history.project_id = ?" : ""}`)
      .get(...(projectId ? [id, projectId] : [id])) as (HistoryRow & { author_username: string | null; author_name: string | null }) | undefined;
    return row ? versionJson(row) : null;
  }

  manifest(projectId: string, versionId: string): HistoryManifest | null {
    const row = this.db.prepare("SELECT manifest_json FROM project_history_versions WHERE id = ? AND project_id = ?")
      .get(versionId, projectId) as { manifest_json: string } | undefined;
    return row ? parseManifest(row.manifest_json) : null;
  }

  /**
   * Validate a single-file restore before the project enters maintenance.
   * restore() repeats the target check while the exclusive operation is held
   * so a directory created between these two checks cannot be replaced.
   */
  validateRestoreTarget(projectId: string, versionId: string, filePathInput?: string): void {
    if (!filePathInput) return;
    const manifest = this.manifest(projectId, versionId);
    if (!manifest) {
      throw httpError(404, "HISTORY_VERSION_NOT_FOUND");
    }
    const filePath = safeRelativePath(filePathInput);
    if (!manifest.files[filePath]) {
      throw httpError(404, "HISTORY_FILE_NOT_FOUND");
    }
    this.assertRestoreTargetIsFile(projectId, filePath);
  }

  previousVersion(projectId: string, versionId: string): HistoryVersion | null {
    const row = this.db.prepare(`SELECT older.id FROM project_history_versions older
      JOIN project_history_versions selected ON selected.id = ? AND selected.project_id = older.project_id
      WHERE older.project_id = ? AND (older.created_at < selected.created_at
        OR (older.created_at = selected.created_at AND older.rowid < selected.rowid))
      ORDER BY older.created_at DESC, older.rowid DESC LIMIT 1`).get(versionId, projectId) as { id: string } | undefined;
    return row ? this.version(row.id, projectId) : null;
  }

  setLabel(projectId: string, versionId: string, label: string | null): HistoryVersion | null {
    const result = this.db.prepare("UPDATE project_history_versions SET label = ? WHERE id = ? AND project_id = ?")
      .run(label, versionId, projectId);
    return result.changes ? this.version(versionId, projectId) : null;
  }

  readTextFile(projectId: string, versionId: string, filePathInput: string): string | null {
    const filePath = safeRelativePath(filePathInput);
    const entry = this.manifest(projectId, versionId)?.files[filePath];
    if (!entry || entry.size > MAX_TEXT_PREVIEW_BYTES) return null;
    return fs.readFileSync(this.objectPath(projectId, entry.digest), "utf8");
  }

  restore(projectId: string, versionId: string, filePathInput?: string): { restoredPaths: string[]; manifest: HistoryManifest } {
    const manifest = this.manifest(projectId, versionId);
    if (!manifest) throw httpError(404, "HISTORY_VERSION_NOT_FOUND");
    if (filePathInput) {
      const filePath = safeRelativePath(filePathInput);
      const entry = manifest.files[filePath];
      if (!entry) throw httpError(404, "HISTORY_FILE_NOT_FOUND");
      this.assertRestoreTargetIsFile(projectId, filePath);
      const target = resolveSourcePath(this.config, projectId, filePath);
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      const temporary = `${target}.history-${randomUUID()}.tmp`;
      try {
        fs.copyFileSync(this.objectPath(projectId, entry.digest), temporary);
        fs.chmodSync(temporary, 0o600);
        fs.renameSync(temporary, target);
      } finally {
        fs.rmSync(temporary, { force: true });
      }
      return { restoredPaths: [filePath], manifest };
    }
    this.restoreProjectTree(projectId, manifest);
    this.db.prepare("UPDATE projects SET main_file = ?, engine = ?, latexmkrc = ? WHERE id = ?")
      .run(manifest.settings.mainFile, manifest.settings.engine, manifest.settings.latexmkrc, projectId);
    return { restoredPaths: Object.keys(manifest.files).sort(), manifest };
  }

  private assertRestoreTargetIsFile(projectId: string, filePath: string): void {
    const target = resolveSourcePath(this.config, projectId, filePath);
    const targetStat = fs.existsSync(target) ? fs.lstatSync(target) : null;
    if (targetStat && !targetStat.isFile()) {
      throw httpError(409, "HISTORY_TARGET_CONFLICT");
    }
  }

  private latestRow(projectId: string): HistoryRow | null {
    return this.db.prepare(`SELECT * FROM project_history_versions WHERE project_id = ?
      ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(projectId) as HistoryRow | undefined ?? null;
  }

  private project(projectId: string): ProjectRow {
    const project = this.db.prepare("SELECT * FROM projects WHERE id = ?").get(projectId) as ProjectRow | undefined;
    if (!project) throw httpError(404, "PROJECT_NOT_FOUND");
    return project;
  }

  private emptyManifest(project: ProjectRow): HistoryManifest {
    return { version: 1, files: {}, settings: settings(project) };
  }

  private snapshotCurrent(projectId: string): HistoryManifest {
    const project = this.project(projectId);
    return { version: 1, files: this.snapshotAllFiles(projectId), settings: settings(project) };
  }

  private baseline(projectId: string): HistoryManifest | null {
    const row = this.db.prepare("SELECT manifest_json FROM project_history_state WHERE project_id = ?")
      .get(projectId) as { manifest_json: string } | undefined;
    return row ? parseManifest(row.manifest_json) : null;
  }

  private saveBaseline(projectId: string, manifest: HistoryManifest): void {
    this.db.prepare(`INSERT INTO project_history_state (project_id, manifest_json, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(project_id) DO UPDATE SET manifest_json = excluded.manifest_json, updated_at = excluded.updated_at`)
      .run(projectId, JSON.stringify(manifest), new Date().toISOString());
  }

  private snapshotAllFiles(projectId: string): Record<string, HistoryFile> {
    const files: Record<string, HistoryFile> = {};
    for (const entry of listProjectFiles(this.config, projectId)) {
      if (entry.type === "file") files[entry.path] = this.storeFile(projectId, entry.path);
    }
    return files;
  }

  private snapshotPath(projectId: string, root: string): Record<string, HistoryFile> {
    const files: Record<string, HistoryFile> = {};
    const absolute = resolveSourcePath(this.config, projectId, root);
    if (!fs.existsSync(absolute)) return files;
    if (fs.statSync(absolute).isFile()) {
      files[root] = this.storeFile(projectId, root);
      return files;
    }
    for (const entry of listProjectFiles(this.config, projectId)) {
      if (entry.type === "file" && entry.path.startsWith(`${root}/`)) files[entry.path] = this.storeFile(projectId, entry.path);
    }
    return files;
  }

  private storeFile(projectId: string, filePath: string): HistoryFile {
    const content = fs.readFileSync(resolveSourcePath(this.config, projectId, filePath));
    const digest = createHash("sha256").update(content).digest("hex");
    const target = this.objectPath(projectId, digest);
    if (!fs.existsSync(target)) {
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      const temporary = `${target}.${randomUUID()}.tmp`;
      fs.writeFileSync(temporary, content, { mode: 0o600 });
      try { fs.renameSync(temporary, target); } catch (error) {
        fs.rmSync(temporary, { force: true });
        if (!fs.existsSync(target)) throw error;
      }
    }
    return { digest, size: content.length };
  }

  private objectPath(projectId: string, digest: string): string {
    if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error("Invalid history object digest");
    return path.join(outputRoot(this.config, projectId), ".texlite", "history", "objects", digest.slice(0, 2), digest);
  }

  private storedObjectDigests(projectId: string): Set<string> {
    const objectsRoot = path.join(outputRoot(this.config, projectId), ".texlite", "history", "objects");
    if (!fs.existsSync(objectsRoot)) return new Set();
    const digests = new Set<string>();
    for (const prefix of fs.readdirSync(objectsRoot, { withFileTypes: true })) {
      if (!prefix.isDirectory() || !/^[a-f0-9]{2}$/.test(prefix.name)) continue;
      const prefixPath = path.join(objectsRoot, prefix.name);
      for (const entry of fs.readdirSync(prefixPath, { withFileTypes: true })) {
        if (entry.isFile() && /^[a-f0-9]{64}$/.test(entry.name) && entry.name.startsWith(prefix.name)) {
          digests.add(entry.name);
        }
      }
    }
    return digests;
  }

  private pruneVersions(projectId: string): void {
    const rows = this.db.prepare(`SELECT *
      FROM project_history_versions WHERE project_id = ?
      ORDER BY created_at DESC, rowid DESC`).all(projectId) as HistoryRow[];
    if (!rows.length) return;

    // Parse manifests and build reference counts & object size tracking in a single pass
    const manifests = new Map<string, HistoryManifest>();
    const refCounts = new Map<string, number>();
    const sizeMap = new Map<string, number>();

    for (const row of rows) {
      const manifest = parseManifest(row.manifest_json);
      manifests.set(row.id, manifest);
      for (const file of Object.values(manifest.files)) {
        refCounts.set(file.digest, (refCounts.get(file.digest) ?? 0) + 1);
        if (!sizeMap.has(file.digest)) sizeMap.set(file.digest, file.size);
      }
    }

    const baseline = this.baseline(projectId);
    if (baseline) {
      for (const file of Object.values(baseline.files)) {
        refCounts.set(file.digest, (refCounts.get(file.digest) ?? 0) + 1);
        if (!sizeMap.has(file.digest)) sizeMap.set(file.digest, file.size);
      }
    }

    let retainedBytes = rows.reduce((sum, row) => sum + historyMetadataBytes(row), 0)
      + (baseline ? Buffer.byteLength(JSON.stringify(baseline), "utf8") : 0);
    for (const [digest, count] of refCounts.entries()) {
      if (count > 0) retainedBytes += sizeMap.get(digest) ?? 0;
    }

    const latestId = rows[0]?.id;
    // Ordinary versions eligible for version count capping (ordered newest to oldest)
    const ordinaryDesc = rows.filter((row) => row.label === null && row.reason !== "initial");

    const toDeleteIds = new Set<string>();
    const rowsById = new Map(rows.map((row) => [row.id, row]));

    const removeVersionRefs = (versionId: string) => {
      if (toDeleteIds.has(versionId)) return;
      toDeleteIds.add(versionId);
      retainedBytes -= historyMetadataBytes(rowsById.get(versionId)!);
      const manifest = manifests.get(versionId);
      if (!manifest) return;
      for (const file of Object.values(manifest.files)) {
        const count = refCounts.get(file.digest);
        if (count !== undefined) {
          if (count === 1) {
            refCounts.set(file.digest, 0);
            retainedBytes -= sizeMap.get(file.digest) ?? 0;
          } else if (count > 1) {
            refCounts.set(file.digest, count - 1);
          }
        }
      }
    };

    // 1. Cap by historyMaxVersions (prune excess ordinary versions when configured; 0 = unlimited)
    if (this.config.historyMaxVersions > 0 && ordinaryDesc.length > this.config.historyMaxVersions) {
      const obsolete = ordinaryDesc.slice(this.config.historyMaxVersions);
      for (const row of obsolete) removeVersionRefs(row.id);
    }

    // 2. Cap by historyMaxStorageBytes (prune remaining eligible versions from oldest to newest)
    if (retainedBytes > this.config.historyMaxStorageBytes) {
      const remainingEligibleAsc = ordinaryDesc
        .filter((row) => row.id !== latestId && !toDeleteIds.has(row.id))
        .reverse();
      for (const row of remainingEligibleAsc) {
        if (retainedBytes <= this.config.historyMaxStorageBytes) break;
        removeVersionRefs(row.id);
      }
    }

    if (!toDeleteIds.size) return;

    // 3. Batch delete rows in a single transaction
    const remove = this.db.prepare("DELETE FROM project_history_versions WHERE id = ? AND project_id = ?");
    this.db.transaction(() => {
      for (const id of toDeleteIds) remove.run(id, projectId);
    })();

    // 4. Remove unreferenced CAS objects on disk
    for (const [digest, count] of refCounts.entries()) {
      if (count === 0) fs.rmSync(this.objectPath(projectId, digest), { force: true });
    }
  }

  private deleteVersions(projectId: string, rows: Array<{ id: string; manifest_json: string }>): void {
    if (!rows.length) return;
    const candidates = new Set<string>();
    for (const row of rows) {
      for (const file of Object.values(parseManifest(row.manifest_json).files)) candidates.add(file.digest);
    }
    const remove = this.db.prepare("DELETE FROM project_history_versions WHERE id = ? AND project_id = ?");
    this.db.transaction(() => { for (const row of rows) remove.run(row.id, projectId); })();
    this.removeUnreferencedObjects(projectId, candidates);
  }

  private removeUnreferencedObjects(projectId: string, candidates: Set<string>): void {
    if (!candidates.size) return;
    const rows = this.db.prepare("SELECT manifest_json FROM project_history_versions WHERE project_id = ?")
      .all(projectId) as Array<{ manifest_json: string }>;
    for (const row of rows) {
      for (const file of Object.values(parseManifest(row.manifest_json).files)) candidates.delete(file.digest);
      if (!candidates.size) return;
    }
    const baseline = this.baseline(projectId);
    if (baseline) {
      for (const file of Object.values(baseline.files)) candidates.delete(file.digest);
    }
    for (const digest of candidates) fs.rmSync(this.objectPath(projectId, digest), { force: true });
  }

  private restoreProjectTree(projectId: string, manifest: HistoryManifest): void {
    assertNoSourceSymlinks(this.config, projectId);
    const root = projectRoot(this.config, projectId);
    const live = sourceRoot(this.config, projectId);
    const temporary = path.join(root, `.history-restore-${randomUUID()}`);
    const backup = path.join(root, `.history-backup-${randomUUID()}`);
    fs.mkdirSync(temporary, { recursive: true, mode: 0o700 });
    let liveMoved = false;
    let replacementInstalled = false;
    let gitMoved = false;
    try {
      for (const [filePath, entry] of Object.entries(manifest.files)) {
        const target = path.join(temporary, safeRelativePath(filePath));
        fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
        fs.copyFileSync(this.objectPath(projectId, entry.digest), target);
        fs.chmodSync(target, 0o600);
      }
      fs.renameSync(live, backup);
      liveMoved = true;
      fs.renameSync(temporary, live);
      replacementInstalled = true;
      const git = path.join(backup, ".git");
      if (fs.existsSync(git)) {
        fs.renameSync(git, path.join(live, ".git"));
        gitMoved = true;
      }
      fs.rmSync(backup, { recursive: true, force: true });
    } catch (error) {
      // A failed restore must leave the original tree, including its Git data,
      // intact. The replacement is entirely reconstructible from history.
      if (replacementInstalled && fs.existsSync(live)) {
        if (gitMoved && fs.existsSync(path.join(live, ".git"))) {
          fs.renameSync(path.join(live, ".git"), path.join(backup, ".git"));
        }
        fs.rmSync(live, { recursive: true, force: true });
      }
      if (liveMoved && fs.existsSync(backup)) fs.renameSync(backup, live);
      fs.rmSync(temporary, { recursive: true, force: true });
      throw error;
    }
  }
}

function settings(project: ProjectRow): HistoryManifest["settings"] {
  return { mainFile: project.main_file, engine: project.engine, latexmkrc: project.latexmkrc };
}

function cloneManifest(manifest: HistoryManifest): HistoryManifest {
  return { version: 1, files: { ...manifest.files }, settings: { ...manifest.settings } };
}

function parseManifest(value: string): HistoryManifest {
  const parsed = JSON.parse(value) as HistoryManifest;
  if (parsed.version !== 1 || !parsed.files || !parsed.settings) throw new Error("History manifest is invalid");
  return parsed;
}

function parseStringArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch { return []; }
}

/**
 * Keep cursors opaque so the public API is free to change its physical
 * ordering later.  `rowid` breaks ties for snapshots written in the same
 * millisecond, which is common for file operations touching multiple paths.
 */
function encodeHistoryCursor(row: HistoryPageRow): string {
  return Buffer.from(JSON.stringify({ createdAt: row.created_at, rowId: row.history_rowid }), "utf8").toString("base64url");
}

function decodeHistoryCursor(value: string): HistoryCursor | null {
  // Cursors are generated by this service and normally only a few dozen
  // characters long.  Bound input before decoding to keep malformed query
  // strings cheap to reject.
  if (value.length === 0 || value.length > 256) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<HistoryCursor>;
    const { createdAt, rowId } = parsed;
    if (typeof createdAt !== "string" || typeof rowId !== "number" || !Number.isSafeInteger(rowId) || rowId <= 0) return null;
    const timestamp = Date.parse(createdAt);
    return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === createdAt
      ? { createdAt, rowId }
      : null;
  } catch {
    return null;
  }
}

function changedManifestPaths(previous: HistoryManifest, next: HistoryManifest): string[] {
  const paths = new Set([...Object.keys(previous.files), ...Object.keys(next.files)]);
  return [...paths].filter((filePath) => previous.files[filePath]?.digest !== next.files[filePath]?.digest).sort();
}

function versionJson(row: HistoryRow & { author_username?: string | null; author_name?: string | null }): HistoryVersion {
  const manifest = parseManifest(row.manifest_json);
  const files = Object.values(manifest.files);
  return {
    id: row.id,
    reason: row.reason,
    label: row.label,
    createdAt: row.created_at,
    author: row.author_id ? {
      id: row.author_id,
      username: row.author_username ?? "deleted-user",
      name: row.author_name ?? "Deleted User"
    } : null,
    changedPaths: parseStringArray(row.changed_paths_json),
    fileCount: files.length,
    totalSize: files.reduce((sum, file) => sum + file.size, 0)
  };
}
