export interface BoundedExpiringCacheLimits {
  /** Lifetime of an entry; it is freed by the sweep timer once it expires. */
  ttlMs: number;
  maxEntries: number;
  /** Total resident bytes across entries, as reported by callers. */
  maxBytes: number;
  /** Larger values are not cached at all. */
  maxEntryBytes: number;
  /** Restart an entry's lifetime when it is read, instead of only when it is written. */
  refreshOnHit?: boolean;
}

/**
 * Small least-recently-used cache bounded by entry count and bytes.
 *
 * The TTL does more than stop an entry from being reused: one unref'd timer,
 * aimed at the earliest expiry, frees expired entries so an idle project's
 * data does not stay resident until something else displaces it. The timer is
 * not re-armed once the cache is empty and never keeps the process alive.
 */
export class BoundedExpiringCache<V> {
  private readonly entries = new Map<string, { value: V; bytes: number; expiresAt: number }>();
  private totalBytes = 0;
  private sweep: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly limits: BoundedExpiringCacheLimits) {}

  get(key: string): V | undefined {
    const entry = this.entries.get(key);
    if (!entry || entry.expiresAt <= Date.now()) return undefined;
    // Refresh recency so an actively used entry is evicted last.
    this.entries.delete(key);
    this.entries.set(key, entry);
    if (this.limits.refreshOnHit) entry.expiresAt = Date.now() + this.limits.ttlMs;
    return entry.value;
  }

  set(key: string, value: V, bytes: number): void {
    this.delete(key);
    if (bytes > this.limits.maxEntryBytes) return;
    this.entries.set(key, { value, bytes, expiresAt: Date.now() + this.limits.ttlMs });
    this.totalBytes += bytes;
    while (this.entries.size > this.limits.maxEntries || this.totalBytes > this.limits.maxBytes) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.delete(oldest);
    }
    this.scheduleSweep();
  }

  delete(key: string): void {
    const removed = this.entries.get(key);
    if (!removed) return;
    this.entries.delete(key);
    this.totalBytes -= removed.bytes;
  }

  stats(): { entries: number; bytes: number } {
    return { entries: this.entries.size, bytes: this.totalBytes };
  }

  private scheduleSweep(): void {
    if (this.sweep !== null || this.entries.size === 0) return;
    let earliest = Infinity;
    for (const entry of this.entries.values()) earliest = Math.min(earliest, entry.expiresAt);
    this.sweep = setTimeout(() => {
      this.sweep = null;
      const now = Date.now();
      for (const [key, entry] of this.entries) {
        if (entry.expiresAt <= now) this.delete(key);
      }
      this.scheduleSweep();
    }, Math.max(0, earliest - Date.now()));
    this.sweep.unref();
  }
}
