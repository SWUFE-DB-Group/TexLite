/**
 * Project snapshot and selection-history payloads, shared by the server that
 * produces them and the browser that shows them.
 */

export type HistoryReason = "initial" | "autosave" | "file" | "settings" | "git" | "restore" | "checkpoint";

export interface HistoryVersion {
  id: string;
  /** Fingerprint of the immutable manifest currently stored for this row. */
  snapshotHash: string;
  reason: HistoryReason;
  label: string | null;
  createdAt: string;
  author: { id: string; username: string; name: string } | null;
  /** A coding agent made at least some of this version's changes. */
  hasAgent: boolean;
  changedPaths: string[];
  fileCount: number;
  totalSize: number;
}

/** A cursor page from the immutable project-snapshot timeline. */
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

/** The snapshot-list response: a page plus storage statistics, which only owners receive. */
export interface HistoryPageResponse extends HistoryPage {
  stats: HistoryStats | null;
}

export interface SelectionHistoryAuthor {
  id: string | null;
  username: string | null;
  name: string | null;
  avatarStyle: string | null;
}

export interface SelectionHistoryEntry {
  id: string;
  filePath: string;
  createdAt: string;
  updatedAt: string;
  /** All users whose relevant edits are included in this short time window. */
  authors: SelectionHistoryAuthor[];
  /**
   * The selected text shown by this entry was written by a coding agent.
   * Time-based grouping never mixes agent and direct edits; when later rows
   * that left the text unchanged are folded together, the flag follows the
   * oldest row, which wrote the text.
   */
  hasAgent: boolean;
  /** Selected source at the end of this editing window. */
  content: string | null;
  contentTruncated: boolean;
}

export interface SelectionHistoryResult {
  entries: SelectionHistoryEntry[];
  baseline: { content: string | null; contentTruncated: boolean } | null;
  hasMore: boolean;
  /** False means an unrecorded source replacement or retention boundary was reached. */
  chainComplete: boolean;
}
