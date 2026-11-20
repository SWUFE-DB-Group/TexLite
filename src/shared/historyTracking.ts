import { isTextContent, resourceFileKind } from "./fileTypes.js";
import { isDrawioFile } from "./drawio.js";

/** Presence on a manifest distinguishes scoped snapshots from legacy full-tree snapshots. */
export interface HistoryTrackingPolicy {
  overrides: Record<string, boolean>;
}

export interface HistoryTrackedFile {
  path: string;
  size: number;
  missing: boolean;
  defaultIncluded: boolean;
  override: boolean | null;
  included: boolean;
}

export function historyTextCandidate(filePath: string): boolean {
  if (!filePath) return false;
  const kind = resourceFileKind(filePath);
  return kind === "text" || kind === "other";
}

/** Track draw.io files as text, but don't compare their serialized diagrams line by line. */
export function historyDiffCandidate(filePath: string): boolean {
  return historyTextCandidate(filePath) && !isDrawioFile(filePath);
}

export function defaultHistoryTracking(filePath: string, bytes: Uint8Array): boolean {
  return historyTextCandidate(filePath) && isTextContent(bytes);
}

export function historyTrackingOverride(policy: HistoryTrackingPolicy, filePath: string): boolean | null {
  return Object.hasOwn(policy.overrides, filePath) ? policy.overrides[filePath] : null;
}
