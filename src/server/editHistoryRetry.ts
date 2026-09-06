import type { EditHistorySegmentInput } from "./editHistory.js";

const RETRY_DELAY_MS = 5_000;
const MAX_RETRIES = 3;
const MAX_PENDING_PROJECT_BYTES = 4 * 1024 * 1024;
const MAX_PENDING_BYTES = 16 * 1024 * 1024;

/** Preserve failed durable-source edits in order, without unbounded memory or retries. */
export class EditHistoryRetry {
  private pending = new Map<string, { edits: EditHistorySegmentInput[]; bytes: number; attempts: number }>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  constructor(private readonly record: (id: string, edits: readonly EditHistorySegmentInput[]) => void,
    private readonly exists: (id: string) => boolean,
    private readonly report: (id: string, state: "ok" | "retrying" | "incomplete" | "discarded", error?: unknown) => void) {}

  save(id: string, edits: readonly EditHistorySegmentInput[]): void {
    if (!edits.length) return;
    const old = this.pending.get(id);
    if (!old) {
      // The queue limits protect only a failed retry buffer. A valid large
      // edit must always get its normal transactional write attempt first.
      try { this.record(id, edits); }
      catch (error) { this.enqueue(id, [...edits], 0, error); }
      return;
    }
    // Preserve the exact order of a previously failed batch. Trying a new
    // write before it has succeeded would be wasteful during an outage and
    // makes the retry path harder to reason about.
    this.enqueue(id, [...old.edits, ...edits], old.attempts);
  }

  clear(id: string): void { this.pending.delete(id); }
  dispose(): void { clearTimeout(this.timer); this.pending.clear(); }

  private enqueue(id: string, edits: EditHistorySegmentInput[], attempts: number, error?: unknown): void {
    let bytes: number;
    try { bytes = Buffer.byteLength(JSON.stringify(edits)); }
    catch (serializationError) {
      this.pending.delete(id);
      this.report(id, "incomplete", serializationError);
      return;
    }
    const previousBytes = this.pending.get(id)?.bytes ?? 0;
    const total = [...this.pending.values()].reduce((sum, item) => sum + item.bytes, 0) - previousBytes;
    if (bytes > MAX_PENDING_PROJECT_BYTES || total + bytes > MAX_PENDING_BYTES) {
      this.pending.delete(id);
      this.report(id, "incomplete", new Error("Edit-history retry queue reached its memory limit"));
      return;
    }
    this.pending.set(id, { edits, bytes, attempts });
    this.report(id, "retrying", error);
    this.schedule();
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      for (const [id, batch] of this.pending) {
        if (!this.exists(id)) {
          this.pending.delete(id);
          this.report(id, "discarded");
          continue;
        }
        try {
          this.record(id, batch.edits);
          this.pending.delete(id); this.report(id, "ok");
        } catch (error) {
          if (++batch.attempts >= MAX_RETRIES) {
            this.pending.delete(id); this.report(id, "incomplete", error);
          } else this.report(id, "retrying", error);
        }
      }
      if (this.pending.size) this.schedule();
    }, RETRY_DELAY_MS);
    this.timer.unref?.();
  }
}
