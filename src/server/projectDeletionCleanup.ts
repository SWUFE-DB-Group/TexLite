import type { DatabaseConnection } from "./db.js";
import { safePathSegment } from "./files.js";

const retryIntervalMs = 60_000;

/** Retries physical cleanup after the transaction that hid deleted projects. */
export class ProjectDeletionCleanup {
  private readonly active = new Map<string, Promise<void>>();
  private timer?: ReturnType<typeof setInterval>;
  private sweep?: Promise<void>;
  private closed = false;

  constructor(
    private readonly db: DatabaseConnection,
    private readonly remove: (projectId: string) => Promise<void>,
    private readonly onError: (error: unknown, projectId?: string) => void
  ) {}

  /** Call inside the same transaction that deletes the project rows. */
  enqueue(projectId: string): void {
    if (safePathSegment(projectId) !== projectId) throw new Error("Invalid project directory ID");
    this.db.prepare("INSERT INTO pending_project_deletions (project_id) VALUES (?)").run(projectId);
  }

  clean(projectId: string): Promise<void> {
    if (this.closed) return Promise.resolve();
    const active = this.active.get(projectId);
    if (active) return active;
    const cleanup = Promise.resolve().then(async () => {
      if (!this.db.prepare("SELECT 1 FROM pending_project_deletions WHERE project_id = ?").get(projectId)) return;
      if (safePathSegment(projectId) !== projectId || this.db.prepare("SELECT 1 FROM projects WHERE id = ?").get(projectId)) {
        throw new Error("Refusing to clean an invalid or live project directory");
      }
      await this.remove(projectId);
      this.db.prepare("DELETE FROM pending_project_deletions WHERE project_id = ?").run(projectId);
    }).catch((error: unknown) => this.onError(error, projectId))
      .finally(() => this.active.delete(projectId));
    this.active.set(projectId, cleanup);
    return cleanup;
  }

  retryPending(): Promise<void> {
    return this.sweep ??= Promise.resolve().then(async () => {
      const pending = this.db.prepare("SELECT project_id FROM pending_project_deletions").all() as { project_id: string }[];
      for (const { project_id } of pending) {
        if (this.closed) break;
        await this.clean(project_id);
      }
    }).catch((error: unknown) => this.onError(error)).finally(() => { this.sweep = undefined; });
  }

  start(): void {
    this.timer ??= setInterval(() => { void this.retryPending(); }, retryIntervalMs);
    this.timer.unref();
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    await Promise.all([this.sweep, ...this.active.values()]);
  }
}
