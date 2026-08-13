import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { Config } from "./config.js";
import type { DatabaseConnection, ProjectRow } from "./db.js";
import { listProjectFiles, outputRoot, projectRoot, resolveSourcePath, safeRelativePath, sourceRoot } from "./files.js";

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

export interface HistoryStats {
  versionCount: number;
  ordinaryVersionCount: number;
  labeledVersionCount: number;
  objectCount: number;
  objectBytes: number;
  maxVersions: number;
  maxStorageBytes: number;
  storageLimitExceeded: boolean;
}

const AUTOSAVE_COALESCE_MS = 2 * 60_000;

export class ProjectHistoryService {
  constructor(private readonly config: Config, private readonly db: DatabaseConnection) {}

  record(projectId: string, authorId: string | null, reason: HistoryReason, changedRoots?: readonly string[]): HistoryVersion | null {
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
    if (reason === "autosave" && previous?.reason === "autosave" && !previous.label && previous.author_id === authorId
      && Date.parse(createdAt) - Date.parse(previous.created_at) < AUTOSAVE_COALESCE_MS) {
      const merged = [...new Set([...parseStringArray(previous.changed_paths_json), ...changedPaths])].sort();
      this.db.prepare(`UPDATE project_history_versions
        SET manifest_json = ?, changed_paths_json = ? WHERE id = ?`)
        .run(JSON.stringify(manifest), JSON.stringify(merged), previous.id);
      this.saveBaseline(projectId, manifest);
      this.removeUnreferencedObjects(projectId, new Set(previousManifest
        ? Object.values(previousManifest.files).map((file) => file.digest)
        : []));
      this.pruneVersions(projectId);
      return this.version(previous.id)!;
    }

    const id = randomUUID();
    this.db.prepare(`INSERT INTO project_history_versions
      (id, project_id, author_id, reason, manifest_json, changed_paths_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(id, projectId, authorId, reason, JSON.stringify(manifest), JSON.stringify(changedPaths), createdAt);
    this.saveBaseline(projectId, manifest);
    this.pruneVersions(projectId);
    return this.version(id)!;
  }

  list(projectId: string, limit = 100): HistoryVersion[] {
    const rows = this.db.prepare(`SELECT history.*, user.username AS author_username, user.display_name AS author_name
      FROM project_history_versions history LEFT JOIN users user ON user.id = history.author_id
      WHERE history.project_id = ? ORDER BY history.created_at DESC, history.rowid DESC LIMIT ?`)
      .all(projectId, Math.min(200, Math.max(1, limit))) as Array<HistoryRow & { author_username: string | null; author_name: string | null }>;
    return rows.map((row) => versionJson(row));
  }

  stats(projectId: string): HistoryStats {
    const rows = this.db.prepare(`SELECT reason, label, manifest_json FROM project_history_versions
      WHERE project_id = ?`).all(projectId) as Array<Pick<HistoryRow, "reason" | "label" | "manifest_json">>;
    const objects = new Map<string, number>();
    let ordinaryVersionCount = 0;
    let labeledVersionCount = 0;
    for (const row of rows) {
      if (row.label) labeledVersionCount += 1;
      else if (row.reason !== "initial") ordinaryVersionCount += 1;
      for (const file of Object.values(parseManifest(row.manifest_json).files)) {
        if (!objects.has(file.digest)) objects.set(file.digest, file.size);
      }
    }
    const baseline = this.baseline(projectId);
    if (baseline) {
      for (const file of Object.values(baseline.files)) {
        if (!objects.has(file.digest)) objects.set(file.digest, file.size);
      }
    }
    const objectBytes = [...objects.values()].reduce((sum, size) => sum + size, 0);
    return {
      versionCount: rows.length,
      ordinaryVersionCount,
      labeledVersionCount,
      objectCount: objects.size,
      objectBytes,
      maxVersions: this.config.historyMaxVersions,
      maxStorageBytes: this.config.historyMaxStorageBytes,
      storageLimitExceeded: objectBytes > this.config.historyMaxStorageBytes
    };
  }

  enforceRetention(projectId: string): void {
    this.pruneVersions(projectId);
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

  setLabel(projectId: string, versionId: string, label: string | null): HistoryVersion | null {
    const result = this.db.prepare("UPDATE project_history_versions SET label = ? WHERE id = ? AND project_id = ?")
      .run(label, versionId, projectId);
    return result.changes ? this.version(versionId, projectId) : null;
  }

  readTextFile(projectId: string, versionId: string, filePathInput: string): string | null {
    const filePath = safeRelativePath(filePathInput);
    const entry = this.manifest(projectId, versionId)?.files[filePath];
    if (!entry || entry.size > 2 * 1024 * 1024) return null;
    return fs.readFileSync(this.objectPath(projectId, entry.digest), "utf8");
  }

  restore(projectId: string, versionId: string, filePathInput?: string): { restoredPaths: string[]; manifest: HistoryManifest } {
    const manifest = this.manifest(projectId, versionId);
    if (!manifest) throw Object.assign(new Error("历史版本不存在"), { code: "HISTORY_VERSION_NOT_FOUND", statusCode: 404 });
    if (filePathInput) {
      const filePath = safeRelativePath(filePathInput);
      const entry = manifest.files[filePath];
      if (!entry) throw Object.assign(new Error("该历史版本中不存在此文件"), { code: "HISTORY_FILE_NOT_FOUND", statusCode: 404 });
      const target = resolveSourcePath(this.config, projectId, filePath);
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      const temporary = `${target}.history-${randomUUID()}.tmp`;
      fs.copyFileSync(this.objectPath(projectId, entry.digest), temporary);
      fs.chmodSync(temporary, 0o600);
      fs.renameSync(temporary, target);
      return { restoredPaths: [filePath], manifest };
    }
    this.restoreProjectTree(projectId, manifest);
    this.db.prepare("UPDATE projects SET main_file = ?, engine = ?, latexmkrc = ? WHERE id = ?")
      .run(manifest.settings.mainFile, manifest.settings.engine, manifest.settings.latexmkrc, projectId);
    return { restoredPaths: Object.keys(manifest.files).sort(), manifest };
  }

  private latestRow(projectId: string): HistoryRow | null {
    return this.db.prepare(`SELECT * FROM project_history_versions WHERE project_id = ?
      ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(projectId) as HistoryRow | undefined ?? null;
  }

  private project(projectId: string): ProjectRow {
    const project = this.db.prepare("SELECT * FROM projects WHERE id = ?").get(projectId) as ProjectRow | undefined;
    if (!project) throw new Error("项目不存在");
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
    if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error("历史对象摘要无效");
    return path.join(outputRoot(this.config, projectId), ".texlite", "history", "objects", digest.slice(0, 2), digest);
  }

  private pruneVersions(projectId: string): void {
    const obsolete = this.db.prepare(`SELECT id, manifest_json FROM project_history_versions
      WHERE project_id = ? AND label IS NULL AND reason <> 'initial'
      ORDER BY created_at DESC, rowid DESC LIMIT -1 OFFSET ?`)
      .all(projectId, this.config.historyMaxVersions) as Array<{ id: string; manifest_json: string }>;
    this.deleteVersions(projectId, obsolete);

    // The latest version is always retained as the baseline for subsequent
    // incremental snapshots. Initial and labeled versions are also protected,
    // so explicitly preserved work can make the project exceed the soft cap.
    while (this.stats(projectId).objectBytes > this.config.historyMaxStorageBytes) {
      const candidate = this.db.prepare(`SELECT id, manifest_json FROM project_history_versions
        WHERE project_id = ? AND label IS NULL AND reason <> 'initial'
          AND id <> (SELECT id FROM project_history_versions WHERE project_id = ?
            ORDER BY created_at DESC, rowid DESC LIMIT 1)
        ORDER BY created_at ASC, rowid ASC LIMIT 1`).get(projectId, projectId) as {
          id: string; manifest_json: string;
        } | undefined;
      if (!candidate) break;
      this.deleteVersions(projectId, [candidate]);
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
  if (parsed.version !== 1 || !parsed.files || !parsed.settings) throw new Error("历史版本清单损坏");
  return parsed;
}

function parseStringArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch { return []; }
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
