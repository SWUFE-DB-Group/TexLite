import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { Config } from "./config.js";
import type { DatabaseConnection, ProjectRow } from "./db.js";
import { assertNoSourceSymlinks, listProjectFiles, outputRoot, projectRoot, resolveSourcePath, safeRelativePath, sourceRoot } from "./files.js";
import { httpError } from "./http.js";
import { MAX_TEXT_PREVIEW_BYTES } from "./limits.js";
import { defaultHistoryTracking, historyTextCandidate, historyTrackingOverride, type HistoryTrackedFile, type HistoryTrackingPolicy } from "../shared/historyTracking.js";
import type { HistoryPage, HistoryReason, HistoryStats, HistoryVersion } from "../shared/historyProtocol.js";
export type { HistoryPage, HistoryReason, HistoryStats, HistoryVersion } from "../shared/historyProtocol.js";

interface HistoryFile {
  digest: string;
  size: number;
  /** Derived from the bytes when stored; absent on older immutable snapshots. */
  textContent?: boolean;
}

export interface HistoryManifest {
  version: 1;
  /** Absent on legacy snapshots, which retain their full-tree restore semantics. */
  tracking?: HistoryTrackingPolicy;
  files: Record<string, HistoryFile>;
  settings: {
    mainFile: string;
    engine: ProjectRow["engine"];
    latexmkrc: string | null;
    /** Optional for snapshots created before ChkTeX was introduced. */
    chktexEnabled?: boolean;
  };
}

interface HistoryRow {
  id: string;
  project_id: string;
  author_id: string | null;
  reason: HistoryReason;
  label: string | null;
  has_agent: number;
  manifest_json: string;
  changed_paths_json: string;
  created_at: string;
}

export interface HistoryRecordOptions {
  /** Recovery checkpoints also protect files a restore will overwrite/delete. */
  tracking?: HistoryTrackingPolicy;
  /**
   * Keep the durable version write in the caller's path, but defer expensive
   * retention work (manifest scans and object garbage collection).
   */
  deferRetention?: boolean;
  /**
   * A coding agent made these changes. Snapshots coalesce only with others
   * that have the same flag.
   */
  hasAgent?: boolean;
  /**
   * Record a version when only the project settings differ from the newest
   * snapshot. A whole-project restore replaces the settings, so its safety
   * checkpoint must keep them even when no file changed.
   */
  keepSettingsChange?: boolean;
}

/**
 * Versions shown in the timeline and used as "previous" comparisons. Older
 * settings-only rows are hidden; a settings-only safety checkpoint is shown.
 */
const VISIBLE_VERSION_SQL = "(json_array_length(%.changed_paths_json) > 0 OR %.reason = 'checkpoint')";
const visibleVersion = (alias: string) => VISIBLE_VERSION_SQL.replaceAll("%", alias);

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

/** Server-local hour or day, matching the local days the timeline is grouped by. */
function historyBucket(time: number, size: "hour" | "day"): string {
  const date = new Date(time);
  const day = `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
  return size === "day" ? `day:${day}` : `hour:${day}:${date.getHours()}`;
}
/** Every version younger than this is kept. */
const HISTORY_KEEP_ALL_MS = DAY_MS;
/** Up to this age one version per hour is kept; older history keeps one per day. */
const HISTORY_KEEP_HOURLY_MS = 7 * DAY_MS;
/** Fixed window, from a run's first save, in which autosaves (or one user's agent writes) share a snapshot. */
const AUTOSAVE_COALESCE_MS = 2 * 60_000;
// Logical stored payload: the UTF-8 bytes of a version row's text columns.
// SQLite pages, indexes and WAL are shared database overhead. octet_length()
// reads only the stored value sizes, never the manifests themselves.
const METADATA_BYTES_SQL = `(octet_length(id) + octet_length(project_id) + COALESCE(octet_length(author_id), 0)
  + octet_length(reason) + COALESCE(octet_length(label), 0) + octet_length(manifest_json)
  + octet_length(changed_paths_json) + octet_length(created_at))`;
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

type RemovableHistoryRow = Pick<HistoryRow, "id" | "manifest_json" | "changed_paths_json" | "created_at"> & { history_rowid: number };

type PrunableHistoryRow = Pick<HistoryRow, "id" | "reason" | "label" | "changed_paths_json" | "created_at"> & {
  history_rowid: number;
  metadata_bytes: number;
};

/** What carrying changed paths needs to know about a removed version. */
type CarriedHistoryRow = Pick<HistoryRow, "changed_paths_json" | "created_at"> & { history_rowid: number };

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
    const tracking = options.tracking ?? this.trackingPolicy(projectId);
    const policyChanged = !previousManifest?.tracking || JSON.stringify(previousManifest.tracking) !== JSON.stringify(tracking);
    // Dropping a file from management is not a file deletion. Old snapshots
    // remain immutable and keep their original recovery scope.
    const comparable = previousManifest && policyChanged
      ? { ...previousManifest, files: this.filterTrackedObjects(projectId, previousManifest.files, tracking) }
      : previousManifest;
    const manifest = comparable ? cloneManifest(comparable) : this.emptyManifest(project);
    manifest.tracking = tracking;
    manifest.settings = settings(project);
    // The baseline assembles the new manifest, because files outside the
    // changed roots are copied from it. Changes are reported against the
    // newest stored version instead: the two differ after that version was
    // deleted, and the timeline must show what changed since the snapshot a
    // user can still see and restore.
    const latestManifest = previous ? parseManifest(previous.manifest_json) : null;
    const reference = latestManifest
      ? JSON.stringify(latestManifest.tracking) === JSON.stringify(tracking)
        ? latestManifest
        : { ...latestManifest, files: this.filterTrackedObjects(projectId, latestManifest.files, tracking) }
      : comparable;

    if (!previousManifest || policyChanged || changedRoots === undefined) {
      manifest.files = this.snapshotAllFiles(projectId, tracking);
    } else {
      for (const rootInput of changedRoots) {
        const root = safeRelativePath(rootInput);
        for (const filePath of Object.keys(manifest.files)) {
          if (filePath === root || filePath.startsWith(`${root}/`)) delete manifest.files[filePath];
        }
        for (const [filePath, file] of Object.entries(this.snapshotPath(projectId, root, tracking))) manifest.files[filePath] = file;
      }
    }

    const changedPaths = reference ? changedManifestPaths(reference, manifest) : Object.keys(manifest.files).sort();
    const keepSettings = Boolean(options.keepSettingsChange && reference && !sameSettings(reference.settings, manifest.settings));
    // Settings alone do not create a file-history entry. Keep the baseline
    // current so the next real file change captures the effective settings.
    if (changedPaths.length === 0 && !keepSettings) {
      this.saveBaseline(projectId, manifest);
      return null;
    }

    const createdAt = new Date().toISOString();
    // Autosaves coalesce across authors, but agent and human changes never
    // share a snapshot, so the state before an agent started stays a separate
    // restore point. A coding agent's file writes, seen by separate source
    // polls, coalesce only with the same user's previous agent write.
    const hasAgent = Boolean(options.hasAgent);
    const sameRun = reason === "autosave"
      ? previous?.reason === "autosave" && Boolean(previous.has_agent) === hasAgent
      : reason === "file" && hasAgent && previous?.reason === "file"
        && Boolean(previous.has_agent) && previous.author_id === authorId;
    if (!policyChanged && sameRun && previous && !previous.label
      && JSON.stringify(parseManifest(previous.manifest_json).tracking) === JSON.stringify(tracking)
      && Date.parse(createdAt) - Date.parse(previous.created_at) < AUTOSAVE_COALESCE_MS) {
      // Report the run's net change against the version before it, so a file
      // edited and then changed back is not listed as changed.
      const beforeRun = this.previousVersion(projectId, previous.id);
      const beforeRunFiles = beforeRun ? this.manifest(projectId, beforeRun.id)?.files ?? {} : {};
      const merged = [...new Set([...parseStringArray(previous.changed_paths_json), ...changedPaths])]
        .filter((filePath) => beforeRunFiles[filePath]?.digest !== manifest.files[filePath]?.digest).sort();
      const runDigests = new Set(Object.values(parseManifest(previous.manifest_json).files).map((file) => file.digest));
      if (merged.length === 0) {
        // The run left every file as the previous version had it, so it is
        // not a restore point of its own.
        this.db.prepare("DELETE FROM project_history_versions WHERE id = ? AND project_id = ?").run(previous.id, projectId);
        this.saveBaseline(projectId, manifest);
        if (!options.deferRetention) this.removeUnreferencedObjects(projectId, runDigests);
        return null;
      }
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
      (id, project_id, author_id, reason, has_agent, manifest_json, changed_paths_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, projectId, authorId, reason, options.hasAgent ? 1 : 0, JSON.stringify(manifest), JSON.stringify(changedPaths), createdAt);
    this.saveBaseline(projectId, manifest);
    if (!options.deferRetention) this.pruneVersions(projectId);
    return this.version(id)!;
  }

  list(projectId: string, limit = 100): HistoryVersion[] {
    const rows = this.db.prepare(`SELECT history.*, user.username AS author_username, user.display_name AS author_name
      FROM project_history_versions history LEFT JOIN users user ON user.id = history.author_id
      WHERE history.project_id = ? AND ${visibleVersion("history")}
      ORDER BY history.created_at DESC, history.rowid DESC LIMIT ?`)
      .all(projectId, Math.min(200, Math.max(1, limit))) as HistoryListRow[];
    return rows.map((row) => versionJson(row));
  }

  trackingPolicy(projectId: string): HistoryTrackingPolicy {
    const rows = this.db.prepare("SELECT path, included FROM project_history_files WHERE project_id = ? ORDER BY path")
      .all(projectId) as Array<{ path: string; included: number }>;
    return { overrides: Object.fromEntries(rows.map((row) => [row.path, row.included === 1])) };
  }

  trackedFiles(projectId: string): HistoryTrackedFile[] {
    const policy = this.trackingPolicy(projectId);
    const files = new Map(listProjectFiles(this.config, projectId).filter((entry) => entry.type === "file").map((entry) => [entry.path, entry]));
    return [...new Set([...files.keys(), ...Object.keys(policy.overrides)])].sort().map((filePath) => {
      const file = files.get(filePath);
      const defaultIncluded = Boolean(file && historyTextCandidate(filePath)
        && defaultHistoryTracking(filePath, fs.readFileSync(resolveSourcePath(this.config, projectId, filePath))));
      const override = historyTrackingOverride(policy, filePath);
      return { path: filePath, size: file?.size ?? 0, missing: !file, defaultIncluded, override, included: override ?? defaultIncluded };
    });
  }

  setFileTracking(projectId: string, filePathInput: string, included: boolean | null): void {
    const filePath = safeRelativePath(filePathInput);
    if (included === null) {
      this.db.prepare("DELETE FROM project_history_files WHERE project_id = ? AND path = ?").run(projectId, filePath);
    } else {
      const target = resolveSourcePath(this.config, projectId, filePath);
      if (!fs.existsSync(target) || !fs.statSync(target).isFile()) throw httpError(404, "FILE_NOT_FOUND", { path: filePath });
      this.db.prepare(`INSERT INTO project_history_files (project_id, path, included) VALUES (?, ?, ?)
        ON CONFLICT(project_id, path) DO UPDATE SET included = excluded.included`).run(projectId, filePath, included ? 1 : 0);
    }
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
      WHERE history.project_id = ? AND ${visibleVersion("history")} ${cursorFilter}
      ORDER BY history.created_at DESC, history.rowid DESC LIMIT ?`)
      .all(...values) as HistoryPageRow[];
    const pageRows = rows.slice(0, limitValue);
    return {
      versions: pageRows.map((row) => versionJson(row)),
      nextCursor: rows.length > limitValue && pageRows.length > 0 ? encodeHistoryCursor(pageRows.at(-1)!) : null
    };
  }

  stats(projectId: string): HistoryStats {
    const rows = this.db.prepare(`SELECT id, reason, label, ${METADATA_BYTES_SQL} AS metadata_bytes
      FROM project_history_versions WHERE project_id = ? ORDER BY created_at DESC, rowid DESC`)
      .all(projectId) as Array<Pick<HistoryRow, "id" | "reason" | "label"> & { metadata_bytes: number }>;
    let metadataBytes = 0;
    let protectedMetadataBytes = 0;
    let ordinaryVersionCount = 0;
    let labeledVersionCount = 0;
    const protectedIds: string[] = [];
    for (const row of rows) {
      const protectedVersion = row === rows[0] || row.reason === "initial" || Boolean(row.label);
      metadataBytes += row.metadata_bytes;
      if (protectedVersion) {
        protectedMetadataBytes += row.metadata_bytes;
        protectedIds.push(row.id);
      }
      if (row.label) labeledVersionCount += 1;
      else if (row.reason !== "initial") ordinaryVersionCount += 1;
    }
    const objects = this.objectSizes(projectId);
    const protectedObjects = new Map<string, number>();
    const versionObjects = this.db.prepare("SELECT digest, size FROM project_history_version_objects WHERE version_id = ?");
    for (const id of protectedIds) {
      for (const object of versionObjects.all(id) as Array<{ digest: string; size: number }>) protectedObjects.set(object.digest, object.size);
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

  /** Each stored content object any version refers to, with its size. */
  private objectSizes(projectId: string): Map<string, number> {
    const rows = this.db.prepare("SELECT digest, size FROM project_history_objects WHERE project_id = ?")
      .all(projectId) as Array<{ digest: string; size: number }>;
    return new Map(rows.map((row) => [row.digest, row.size]));
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
    const row = this.db.prepare(`SELECT id, manifest_json, changed_paths_json, created_at, rowid AS history_rowid
      FROM project_history_versions WHERE id = ? AND project_id = ?`)
      .get(versionId, projectId) as RemovableHistoryRow | undefined;
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
   * A short autosave window deliberately coalesces updates into one row. A
   * client that has been inspecting that row must not restore newer contents
   * it has not reviewed, so verify the manifest fingerprint immediately
   * before a restore mutates the project.
   */
  assertSnapshotHash(projectId: string, versionId: string, expectedHash: string | undefined): void {
    if (!expectedHash) return;
    const row = this.db.prepare("SELECT manifest_json FROM project_history_versions WHERE id = ? AND project_id = ?")
      .get(versionId, projectId) as { manifest_json: string } | undefined;
    if (!row) throw httpError(404, "HISTORY_VERSION_NOT_FOUND");
    if (historySnapshotHash(row.manifest_json) !== expectedHash) {
      throw httpError(409, "HISTORY_VERSION_CHANGED");
    }
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
      WHERE older.project_id = ? AND ${visibleVersion("older")}
        AND (older.created_at < selected.created_at
        OR (older.created_at = selected.created_at AND older.rowid < selected.rowid))
      ORDER BY older.created_at DESC, older.rowid DESC LIMIT 1`).get(versionId, projectId) as { id: string } | undefined;
    return row ? this.version(row.id, projectId) : null;
  }

  setLabel(projectId: string, versionId: string, label: string | null): HistoryVersion | null {
    const result = this.db.prepare("UPDATE project_history_versions SET label = ? WHERE id = ? AND project_id = ?")
      .run(label, versionId, projectId);
    return result.changes ? this.version(versionId, projectId) : null;
  }

  /** Share the recording classifier with the UI without rereading modern objects. */
  isTextFile(projectId: string, filePath: string, file: HistoryFile | undefined): boolean | undefined {
    if (!historyTextCandidate(filePath)) return false;
    if (file?.textContent !== undefined) return file.textContent;
    // Do not read oversized legacy objects just to build the file list. The
    // comparison endpoint reports size/missing-object errors when selected.
    if (!file || file.size > MAX_TEXT_PREVIEW_BYTES) return undefined;
    try {
      return defaultHistoryTracking(filePath, fs.readFileSync(this.objectPath(projectId, file.digest)));
    } catch {
      // Keep snapshot metadata browsable even if an old object is unavailable.
      return undefined;
    }
  }

  readTextFile(projectId: string, versionId: string, filePathInput: string): string | null {
    const filePath = safeRelativePath(filePathInput);
    if (!historyTextCandidate(filePath)) return null;
    const entry = this.manifest(projectId, versionId)?.files[filePath];
    if (!entry || entry.textContent === false || entry.size > MAX_TEXT_PREVIEW_BYTES) return null;
    return this.readStoredObject(projectId, entry.digest, filePath);
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
        this.copyStoredObject(projectId, entry.digest, filePath, temporary);
        fs.chmodSync(temporary, 0o600);
        fs.renameSync(temporary, target);
      } finally {
        fs.rmSync(temporary, { force: true });
      }
      return { restoredPaths: [filePath], manifest };
    }
    this.restoreProjectTree(projectId, manifest);
    this.db.prepare("UPDATE projects SET main_file = ?, engine = ?, latexmkrc = ?, chktex_enabled = ? WHERE id = ?")
      .run(manifest.settings.mainFile, manifest.settings.engine, manifest.settings.latexmkrc, manifest.settings.chktexEnabled ? 1 : 0, projectId);
    return { restoredPaths: Object.keys(manifest.files).sort(), manifest };
  }

  checkpointForRestore(projectId: string, authorId: string, versionId: string, filePathInput?: string): HistoryVersion | null {
    const target = this.manifest(projectId, versionId);
    if (!target) throw httpError(404, "HISTORY_VERSION_NOT_FOUND");
    const current = this.trackingPolicy(projectId);
    const tracking = { overrides: { ...current.overrides } };
    const selected = filePathInput ? safeRelativePath(filePathInput) : null;
    for (const file of listProjectFiles(this.config, projectId)) {
      if (file.type !== "file" || (selected && file.path !== selected)) continue;
      const affected = selected !== null || Boolean(target.files[file.path]) || !target.tracking
        || this.tracksFile(projectId, file.path, target.tracking);
      if (affected && !this.tracksFile(projectId, file.path, current)) tracking.overrides[file.path] = true;
    }
    // This policy belongs only to the safety checkpoint, not project settings.
    // Even a legacy restore or a single excluded file must remain reversible.
    return this.record(projectId, authorId, "checkpoint", undefined, { tracking, keepSettingsChange: selected === null });
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
    const tracking = this.trackingPolicy(projectId);
    return { version: 1, tracking, files: this.snapshotAllFiles(projectId, tracking), settings: settings(project) };
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

  private snapshotAllFiles(projectId: string, tracking: HistoryTrackingPolicy): Record<string, HistoryFile> {
    const files: Record<string, HistoryFile> = {};
    for (const entry of listProjectFiles(this.config, projectId)) {
      if (entry.type !== "file") continue;
      const file = this.storeFile(projectId, entry.path, tracking);
      if (file) files[entry.path] = file;
    }
    return files;
  }

  private snapshotPath(projectId: string, root: string, tracking: HistoryTrackingPolicy): Record<string, HistoryFile> {
    const files: Record<string, HistoryFile> = {};
    const absolute = resolveSourcePath(this.config, projectId, root);
    if (!fs.existsSync(absolute)) return files;
    if (fs.statSync(absolute).isFile()) {
      const file = this.storeFile(projectId, root, tracking);
      if (file) files[root] = file;
      return files;
    }
    for (const entry of listProjectFiles(this.config, projectId)) {
      if (entry.type === "file" && entry.path.startsWith(`${root}/`)) {
        const file = this.storeFile(projectId, entry.path, tracking);
        if (file) files[entry.path] = file;
      }
    }
    return files;
  }

  private filterTrackedObjects(projectId: string, files: Record<string, HistoryFile>, tracking: HistoryTrackingPolicy): Record<string, HistoryFile> {
    return Object.fromEntries(Object.entries(files).filter(([filePath, file]) => {
      const override = historyTrackingOverride(tracking, filePath);
      if (override !== null) return override;
      return historyTextCandidate(filePath) && defaultHistoryTracking(filePath, fs.readFileSync(this.objectPath(projectId, file.digest)));
    }));
  }

  private tracksFile(projectId: string, filePath: string, tracking: HistoryTrackingPolicy): boolean {
    return historyTrackingOverride(tracking, filePath)
      ?? (historyTextCandidate(filePath) && defaultHistoryTracking(filePath, fs.readFileSync(resolveSourcePath(this.config, projectId, filePath))));
  }

  private storeFile(projectId: string, filePath: string, tracking: HistoryTrackingPolicy): HistoryFile | null {
    const override = historyTrackingOverride(tracking, filePath);
    if (override === false || (override === null && !historyTextCandidate(filePath))) return null;
    const content = fs.readFileSync(resolveSourcePath(this.config, projectId, filePath));
    const textContent = defaultHistoryTracking(filePath, content);
    if (override === null && !textContent) return null;
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
    return { digest, size: content.length, textContent };
  }

  private objectPath(projectId: string, digest: string): string {
    if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error("Invalid history object digest");
    return path.join(outputRoot(this.config, projectId), ".texlite", "history", "objects", digest.slice(0, 2), digest);
  }

  /**
   * A history manifest can outlive a damaged or manually removed object. Keep
   * that operational failure distinct from an absent path in the snapshot so
   * the UI can tell the user why viewing or restoring it is impossible.
   */
  private readStoredObject(projectId: string, digest: string, filePath: string): string | null {
    try {
      const bytes = fs.readFileSync(this.objectPath(projectId, digest));
      return defaultHistoryTracking(filePath, bytes) ? bytes.toString("utf8") : null;
    } catch (error) {
      this.rethrowHistoryObjectError(error, filePath);
    }
  }

  private copyStoredObject(projectId: string, digest: string, filePath: string, target: string): void {
    try {
      fs.copyFileSync(this.objectPath(projectId, digest), target);
    } catch (error) {
      this.rethrowHistoryObjectError(error, filePath);
    }
  }

  private rethrowHistoryObjectError(error: unknown, filePath: string): never {
    const code = typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
      ? error.code : "";
    if (code === "ENOENT" || code === "ENOTDIR" || code === "EISDIR") {
      throw httpError(410, "HISTORY_OBJECT_MISSING", { path: filePath });
    }
    throw error;
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
    const rows = this.db.prepare(`SELECT id, reason, label, created_at, changed_paths_json, rowid AS history_rowid,
      ${METADATA_BYTES_SQL} AS metadata_bytes
      FROM project_history_versions WHERE project_id = ?
      ORDER BY created_at DESC, rowid DESC`).all(projectId) as PrunableHistoryRow[];
    if (!rows.length) return;

    // Reference counts are kept by the database for each stored content, so
    // retention never parses manifests; a version's objects are read only if
    // that version is removed.
    const refCounts = new Map<string, number>();
    const sizeMap = new Map<string, number>();
    for (const row of this.db.prepare("SELECT digest, refs, size FROM project_history_objects WHERE project_id = ?")
      .all(projectId) as Array<{ digest: string; refs: number; size: number }>) {
      refCounts.set(row.digest, row.refs);
      sizeMap.set(row.digest, row.size);
    }

    const baseline = this.baseline(projectId);
    if (baseline) {
      for (const file of Object.values(baseline.files)) {
        refCounts.set(file.digest, (refCounts.get(file.digest) ?? 0) + 1);
        if (!sizeMap.has(file.digest)) sizeMap.set(file.digest, file.size);
      }
    }

    let retainedBytes = rows.reduce((sum, row) => sum + row.metadata_bytes, 0)
      + (baseline ? Buffer.byteLength(JSON.stringify(baseline), "utf8") : 0);
    for (const [digest, count] of refCounts.entries()) {
      if (count > 0) retainedBytes += sizeMap.get(digest) ?? 0;
    }

    const latestId = rows[0]?.id;
    // Ordinary versions eligible for version count capping (ordered newest to oldest)
    const ordinaryDesc = rows.filter((row) => row.label === null && row.reason !== "initial");
    const overVersionLimit = this.config.historyMaxVersions > 0 && ordinaryDesc.length > this.config.historyMaxVersions;
    if (!overVersionLimit && retainedBytes <= this.config.historyMaxStorageBytes) return;

    const toDeleteIds = new Set<string>();
    const rowsById = new Map(rows.map((row) => [row.id, row]));
    const versionObjects = this.db.prepare("SELECT digest FROM project_history_version_objects WHERE version_id = ?");

    const removeVersionRefs = (versionId: string) => {
      if (toDeleteIds.has(versionId)) return;
      toDeleteIds.add(versionId);
      retainedBytes -= rowsById.get(versionId)!.metadata_bytes;
      for (const { digest } of versionObjects.all(versionId) as Array<{ digest: string }>) {
        const count = refCounts.get(digest);
        if (count === 1) {
          refCounts.set(digest, 0);
          retainedBytes -= sizeMap.get(digest) ?? 0;
        } else if (count !== undefined && count > 1) {
          refCounts.set(digest, count - 1);
        }
      }
    };

    // 1. Cap by historyMaxVersions (prune excess ordinary versions when configured; 0 = unlimited)
    const remainingOrdinary = () => ordinaryDesc.filter((row) => !toDeleteIds.has(row.id));
    if (overVersionLimit) {
      const obsolete = ordinaryDesc.slice(this.config.historyMaxVersions);
      for (const row of obsolete) removeVersionRefs(row.id);
    }

    // 2. Over the storage budget, first thin older history so the budget
    // covers a longer period: keep every version from the last day, the newest
    // of each local hour for the last week, and the newest of each local day
    // before that. The latest version occupies its own hour or day. Labeled,
    // initial, restore and pre-restore checkpoint versions are never thinned.
    // Under the budget nothing is removed.
    if (retainedBytes > this.config.historyMaxStorageBytes) {
      const now = Date.now();
      const keptBuckets = new Set<string>();
      for (const row of remainingOrdinary()) {
        const time = Date.parse(row.created_at);
        if (!Number.isFinite(time) || now - time <= HISTORY_KEEP_ALL_MS) continue;
        const bucket = historyBucket(time, now - time <= HISTORY_KEEP_HOURLY_MS ? "hour" : "day");
        if (row.id === latestId || row.reason === "restore" || row.reason === "checkpoint") {
          if (row.id === latestId) keptBuckets.add(bucket);
          continue;
        }
        if (keptBuckets.has(bucket)) removeVersionRefs(row.id);
        else keptBuckets.add(bucket);
      }
    }

    // 3. Still over the budget: prune remaining eligible versions from oldest to newest.
    if (retainedBytes > this.config.historyMaxStorageBytes) {
      const remainingEligibleAsc = remainingOrdinary()
        .filter((row) => row.id !== latestId)
        .reverse();
      for (const row of remainingEligibleAsc) {
        if (retainedBytes <= this.config.historyMaxStorageBytes) break;
        removeVersionRefs(row.id);
      }
    }

    if (!toDeleteIds.size) return;

    // 4. Batch delete rows in a single transaction
    const remove = this.db.prepare("DELETE FROM project_history_versions WHERE id = ? AND project_id = ?");
    this.db.transaction(() => {
      for (const id of toDeleteIds) remove.run(id, projectId);
      this.carryChangedPaths(projectId, rows.filter((row) => toDeleteIds.has(row.id)));
    })();

    // 5. Remove unreferenced CAS objects on disk
    for (const [digest, count] of refCounts.entries()) {
      if (count === 0) fs.rmSync(this.objectPath(projectId, digest), { force: true });
    }
  }

  private deleteVersions(projectId: string, rows: RemovableHistoryRow[]): void {
    if (!rows.length) return;
    const candidates = new Set<string>();
    for (const row of rows) {
      for (const file of Object.values(parseManifest(row.manifest_json).files)) candidates.add(file.digest);
    }
    const remove = this.db.prepare("DELETE FROM project_history_versions WHERE id = ? AND project_id = ?");
    this.db.transaction(() => {
      for (const row of rows) remove.run(row.id, projectId);
      this.carryChangedPaths(projectId, rows);
    })();
    this.removeUnreferencedObjects(projectId, candidates);
  }

  /**
   * Each version lists the files changed since the version before it. When
   * versions are removed, the next remaining version is now compared with an
   * older one, so it takes over the removed versions' changes. Only files that
   * still differ from the new predecessor are kept.
   */
  private carryChangedPaths(projectId: string, removed: readonly CarriedHistoryRow[]): void {
    if (!removed.length) return;
    const order = (left: { created_at: string; history_rowid: number }, right: { created_at: string; history_rowid: number }) =>
      left.created_at < right.created_at ? -1 : left.created_at > right.created_at ? 1 : left.history_rowid - right.history_rowid;
    const pending = [...removed].sort(order);
    const survivors = this.db.prepare(`SELECT id, rowid AS history_rowid, created_at, changed_paths_json
      FROM project_history_versions history WHERE project_id = ? AND ${visibleVersion("history")}
      ORDER BY created_at ASC, rowid ASC`).all(projectId) as Array<{ id: string; history_rowid: number; created_at: string; changed_paths_json: string }>;
    const update = this.db.prepare("UPDATE project_history_versions SET changed_paths_json = ? WHERE id = ? AND project_id = ?");
    let next = 0;
    let previousId: string | null = null;
    for (const survivor of survivors) {
      const carried = new Set<string>();
      while (next < pending.length && order(pending[next]!, survivor) < 0) {
        for (const filePath of parseStringArray(pending[next]!.changed_paths_json)) carried.add(filePath);
        next += 1;
      }
      if (carried.size) {
        const own = parseStringArray(survivor.changed_paths_json);
        const files = this.manifest(projectId, survivor.id)!.files;
        const before = previousId ? this.manifest(projectId, previousId)!.files : {};
        const differing = [...new Set([...own, ...carried])].filter((filePath) => before[filePath]?.digest !== files[filePath]?.digest).sort();
        // An identical version keeps its old list rather than vanishing from
        // the timeline, which hides versions without changed files.
        const combined = differing.length ? differing : [...own].sort();
        if (JSON.stringify(combined) !== survivor.changed_paths_json) update.run(JSON.stringify(combined), survivor.id, projectId);
      }
      previousId = survivor.id;
      if (next >= pending.length) break;
    }
  }

  private removeUnreferencedObjects(projectId: string, candidates: Set<string>): void {
    if (!candidates.size) return;
    const referenced = this.db.prepare("SELECT 1 FROM project_history_objects WHERE project_id = ? AND digest = ?");
    const baselineDigests = new Set(Object.values(this.baseline(projectId)?.files ?? {}).map((file) => file.digest));
    for (const digest of candidates) {
      if (baselineDigests.has(digest) || referenced.get(projectId, digest)) continue;
      fs.rmSync(this.objectPath(projectId, digest), { force: true });
    }
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
      if (manifest.tracking) {
        const entries = listProjectFiles(this.config, projectId);
        // An empty folder holds nothing a snapshot records, so like other
        // content outside the snapshot's scope it survives the restore.
        const files = entries.filter((entry) => entry.type === "file").map((entry) => entry.path);
        for (const folder of entries) {
          if (folder.type !== "directory" || files.some((filePath) => filePath.startsWith(`${folder.path}/`))) continue;
          fs.mkdirSync(path.join(temporary, safeRelativePath(folder.path)), { recursive: true, mode: 0o700 });
        }
        // Files outside this snapshot's scope survive a project restore. Stage
        // them before swapping trees so a copy/conflict failure is harmless.
        for (const file of entries) {
          if (file.type !== "file" || manifest.files[file.path]) continue;
          const source = resolveSourcePath(this.config, projectId, file.path);
          if (this.tracksFile(projectId, file.path, manifest.tracking)) continue;
          const target = path.join(temporary, safeRelativePath(file.path));
          fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
          fs.copyFileSync(source, target);
        }
      }
      for (const [filePath, entry] of Object.entries(manifest.files)) {
        const target = path.join(temporary, safeRelativePath(filePath));
        fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
        this.copyStoredObject(projectId, entry.digest, filePath, target);
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
  return { mainFile: project.main_file, engine: project.engine, latexmkrc: project.latexmkrc, chktexEnabled: Boolean(project.chktex_enabled) };
}

function sameSettings(left: HistoryManifest["settings"], right: HistoryManifest["settings"]): boolean {
  return left.mainFile === right.mainFile && left.engine === right.engine && left.latexmkrc === right.latexmkrc
    && Boolean(left.chktexEnabled) === Boolean(right.chktexEnabled);
}

function cloneManifest(manifest: HistoryManifest): HistoryManifest {
  return { ...manifest, files: { ...manifest.files }, settings: { ...manifest.settings } };
}

function parseManifest(value: string): HistoryManifest {
  const parsed = JSON.parse(value) as HistoryManifest;
  if (parsed.version !== 1 || !parsed.files || !parsed.settings) throw new Error("History manifest is invalid");
  return { ...parsed, settings: { ...parsed.settings, chktexEnabled: parsed.settings.chktexEnabled === true } };
}

function parseStringArray(value: string): string[] {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
    throw new Error("Invalid snapshot changed paths");
  }
  return parsed;
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
    snapshotHash: historySnapshotHash(row.manifest_json),
    reason: row.reason,
    label: row.label,
    createdAt: row.created_at,
    author: row.author_id ? {
      id: row.author_id,
      username: row.author_username ?? "deleted-user",
      name: row.author_name ?? "Deleted User"
    } : null,
    hasAgent: Boolean(row.has_agent),
    changedPaths: parseStringArray(row.changed_paths_json),
    fileCount: files.length,
    totalSize: files.reduce((sum, file) => sum + file.size, 0)
  };
}

function historySnapshotHash(manifestJson: string): string {
  return createHash("sha256").update(manifestJson, "utf8").digest("hex");
}
