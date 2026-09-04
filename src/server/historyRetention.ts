/**
 * Coalesces non-critical history retention work. A history version is already
 * durable before this scheduler runs; delaying maintenance can only leave
 * extra old versions/objects temporarily, never lose a recoverable version.
 */
export const HISTORY_RETENTION_DELAY_MS = 30_000;

export interface HistoryRetentionTarget {
  enforceRetention(projectId: string): void;
}

interface HistoryRetentionSchedulerOptions {
  delayMs?: number;
  onError?: (error: unknown, projectId: string) => void;
}

export class HistoryRetentionScheduler {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly delayMs: number;
  private readonly onError?: (error: unknown, projectId: string) => void;

  constructor(private readonly history: HistoryRetentionTarget, options: HistoryRetentionSchedulerOptions = {}) {
    this.delayMs = options.delayMs ?? HISTORY_RETENTION_DELAY_MS;
    this.onError = options.onError;
  }

  schedule(projectId: string): void {
    if (this.timers.has(projectId)) return;
    const timer = setTimeout(() => {
      this.timers.delete(projectId);
      try {
        this.history.enforceRetention(projectId);
      } catch (error) {
        this.onError?.(error, projectId);
      }
    }, this.delayMs);
    timer.unref?.();
    this.timers.set(projectId, timer);
  }

  dispose(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }
}
