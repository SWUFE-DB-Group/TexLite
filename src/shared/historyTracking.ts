import { isTextContent, resourceFileKind } from "./fileTypes.js";

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
  const kind = resourceFileKind(filePath);
  return kind === "text" || kind === "other";
}

export function defaultHistoryTracking(filePath: string, bytes: Uint8Array): boolean {
  return historyTextCandidate(filePath) && isTextContent(bytes);
}

export function historyTrackingOverride(policy: HistoryTrackingPolicy, filePath: string): boolean | null {
  return Object.hasOwn(policy.overrides, filePath) ? policy.overrides[filePath] : null;
}
