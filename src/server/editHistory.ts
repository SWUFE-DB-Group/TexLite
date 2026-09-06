import { createHash, randomUUID } from "node:crypto";
import type { DatabaseConnection } from "./db.js";
import { safeRelativePath } from "./files.js";

/**
 * An edit step is deliberately smaller than a recovery snapshot. It describes
 * only positional replacements in one source revision, which is enough to
 * map a current selection backwards through the saved collaboration stream.
 */
export type EditHistoryKind = "edit" | "format";

export interface EditHistorySpan {
  beforeStart: number;
  beforeEnd: number;
  afterStart: number;
  afterEnd: number;
  deletedLength: number;
  insertedLength: number;
  deletedPreview: string;
  insertedPreview: string;
  truncated: boolean;
}

export interface EditHistoryStep {
  beforeHash: string;
  afterHash: string;
  createdAt: string;
  spans: EditHistorySpan[];
}

/** Input supplied by the live Yjs room after its corresponding source write succeeds. */
export interface EditHistorySegmentInput {
  filePath: string;
  authorId: string;
  kind: EditHistoryKind;
  beforeHash: string;
  afterHash: string;
  createdAt: string;
  updatedAt: string;
  steps: EditHistoryStep[];
}

interface EditHistoryRow {
  id: string;
  project_id: string;
  file_path: string;
  author_id: string | null;
  kind: EditHistoryKind;
  before_hash: string;
  after_hash: string;
  steps_json: string;
  created_at: string;
  updated_at: string;
  author_username: string | null;
  author_name: string | null;
}

export interface SelectionHistoryAuthor {
  id: string | null;
  username: string | null;
  name: string | null;
}

export interface SelectionHistoryEntry {
  id: string;
  filePath: string;
  createdAt: string;
  updatedAt: string;
  /** All users whose relevant edits are included in this short time window. */
  authors: SelectionHistoryAuthor[];
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

const MAX_SEGMENTS_PER_PROJECT = 5_000;
const MAX_SEGMENTS_TO_SCAN = MAX_SEGMENTS_PER_PROJECT;
const DEFAULT_RESULT_LIMIT = 60;
const EDIT_SESSION_GAP_MS = 2 * 60 * 1_000;
const MAX_PASSAGE_PREVIEW_CHARS = 6_000;
export const DEFAULT_EDIT_HISTORY_MAX_STORAGE_BYTES = 32 * 1024 * 1024;

interface StoredSegment {
  segment: EditHistorySegmentInput;
  stepsJson: string;
  stepsBytes: number;
}

interface SegmentStorageRow {
  id: string;
  file_path: string;
  after_hash: string;
  updated_at: string;
  steps_bytes: number;
}

interface PassageState {
  range: TextRange;
  text: string;
  exact: boolean;
}

interface OpenSelectionHistoryEntry extends SelectionHistoryEntry {
  authorKeys: Set<string>;
}

/**
 * Stores author-isolated collaboration edits independently from retained
 * project snapshots. A segment is a short, contiguous run from one user and
 * one file; its steps remain ordered so selection mapping remains exact.
 */
export class ProjectEditHistoryService {
  private readonly maxStorageBytes: number;

  constructor(private readonly db: DatabaseConnection, maxStorageBytes = DEFAULT_EDIT_HISTORY_MAX_STORAGE_BYTES) {
    this.maxStorageBytes = normalizeStorageLimit(maxStorageBytes);
  }

  record(projectId: string, inputs: readonly EditHistorySegmentInput[]): void {
    const normalized = inputs
      .map(normalizeSegment)
      .filter((segment): segment is EditHistorySegmentInput => segment !== null);
    if (!normalized.length) return;
    const segments: StoredSegment[] = [];
    const skipped: EditHistorySegmentInput[] = [];
    for (const segment of normalized) {
      const stepsJson = JSON.stringify(segment.steps);
      const stepsBytes = Buffer.byteLength(stepsJson, "utf8");
      // A single oversized burst would make the quota ineffective. Dropping it
      // creates an explicit, safe history boundary rather than retaining a
      // partial delta that could misattribute an older selection.
      if (stepsBytes > this.maxStorageBytes) skipped.push(segment);
      else segments.push({ segment, stepsJson, stepsBytes });
    }
    const insert = this.db.prepare(`INSERT INTO project_edit_segments
      (id, project_id, file_path, author_id, kind, before_hash, after_hash, steps_json, created_at, updated_at, steps_bytes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    this.db.transaction(() => {
      for (const { segment, stepsJson, stepsBytes } of segments) {
        insert.run(
          randomUUID(), projectId, segment.filePath, segment.authorId, segment.kind,
          segment.beforeHash, segment.afterHash, stepsJson, segment.createdAt, segment.updatedAt, stepsBytes
        );
      }
      for (const segment of skipped) this.recordRetentionBoundary(projectId, segment.filePath, segment.afterHash, segment.updatedAt);
      this.prune(projectId);
    })();
  }

  /** Logical edit payload; shared SQLite pages and indexes are not included. */
  stats(projectId: string): { segmentCount: number; payloadBytes: number; maxStorageBytes: number } {
    const row = this.db.prepare(`SELECT COUNT(*) AS segmentCount,
      COALESCE(SUM(steps_bytes), 0) AS payloadBytes
      FROM project_edit_segments WHERE project_id = ?`).get(projectId) as { segmentCount: number; payloadBytes: number };
    return { ...row, maxStorageBytes: this.maxStorageBytes };
  }

  clear(projectId: string): void {
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM project_edit_segments WHERE project_id = ?").run(projectId);
      this.db.prepare("DELETE FROM project_edit_history_boundaries WHERE project_id = ?").run(projectId);
    })();
  }

  /** Apply a changed storage setting to retained records during startup. */
  enforceRetention(projectId: string): void {
    this.db.transaction(() => this.prune(projectId))();
  }

  /** Keep the newest contiguous suffix within both record and payload limits. */
  private prune(projectId: string): void {
    const rows = this.db.prepare(`SELECT id, file_path, after_hash, updated_at, steps_bytes
      FROM project_edit_segments WHERE project_id = ?
      ORDER BY updated_at DESC, rowid DESC`).all(projectId) as SegmentStorageRow[];
    let retainedBytes = 0;
    let retainedCount = 0;
    let firstDiscard = rows.length;
    for (let index = 0; index < rows.length; index += 1) {
      const size = Math.max(0, Number(rows[index]!.steps_bytes) || 0);
      if (retainedCount >= MAX_SEGMENTS_PER_PROJECT || retainedBytes + size > this.maxStorageBytes) {
        firstDiscard = index;
        break;
      }
      retainedBytes += size;
      retainedCount += 1;
    }
    if (firstDiscard === rows.length) return;
    const remove = this.db.prepare("DELETE FROM project_edit_segments WHERE id = ?");
    const boundaryFiles = new Set<string>();
    for (const row of rows.slice(firstDiscard)) {
      // Rows are newest first. The first discarded row for a source file is
      // precisely where a backward selection map must stop.
      if (!boundaryFiles.has(row.file_path)) {
        boundaryFiles.add(row.file_path);
        this.recordRetentionBoundary(projectId, row.file_path, row.after_hash, row.updated_at);
      }
      remove.run(row.id);
    }
  }

  private recordRetentionBoundary(projectId: string, filePath: string, afterHash: string, updatedAt: string): void {
    this.db.prepare(`INSERT INTO project_edit_history_boundaries (project_id, file_path, after_hash, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(project_id, file_path) DO UPDATE SET after_hash = excluded.after_hash, updated_at = excluded.updated_at`)
      .run(projectId, filePath, afterHash, updatedAt);
  }

  selectionHistory(
    projectId: string,
    filePathInput: string,
    currentSource: string,
    startInput: number,
    endInput: number,
    resultLimit = DEFAULT_RESULT_LIMIT
  ): SelectionHistoryResult {
    const filePath = safeRelativePath(filePathInput);
    const start = clamp(Math.min(startInput, endInput), 0, currentSource.length);
    const end = clamp(Math.max(startInput, endInput), start, currentSource.length);
    const rows = this.db.prepare(`SELECT segment.*, user.username AS author_username, user.display_name AS author_name
      FROM project_edit_segments segment LEFT JOIN users user ON user.id = segment.author_id
      WHERE segment.project_id = ? AND segment.file_path = ?
      ORDER BY segment.updated_at DESC, segment.rowid DESC LIMIT ?`)
      .all(projectId, filePath, MAX_SEGMENTS_TO_SCAN) as EditHistoryRow[];

    const entries: SelectionHistoryEntry[] = [];
    let passage: PassageState = {
      range: { start, end },
      text: currentSource.slice(start, end),
      exact: true
    };
    let openEntry: OpenSelectionHistoryEntry | null = null;
    let expectedHash = hashText(currentSource);
    let chainComplete = true;
    let exhaustedRows = true;
    let baseline: SelectionHistoryResult["baseline"] = null;
    const limit = clamp(resultLimit, 1, DEFAULT_RESULT_LIMIT);

    for (const row of rows) {
      // A direct file replacement, restoration, import, or retained-history
      // pruning can intentionally create a gap. Never guess across it: doing
      // so would attribute someone else's text to the wrong user.
      if (row.after_hash !== expectedHash) {
        chainComplete = false;
        break;
      }
      const steps = parseSteps(row.steps_json);
      if (!steps.length) {
        chainComplete = false;
        break;
      }
      let relevant = false;
      let valid = true;
      const afterPassage = passage;
      const afterHash = expectedHash;
      for (let index = steps.length - 1; index >= 0; index -= 1) {
        const step = steps[index];
        if (step.afterHash !== expectedHash) {
          valid = false;
          break;
        }
        const beforeRange = mapRangeBackward(passage.range, step.spans);
        const relevantSpans = step.spans.filter((span) => spanIntersectsRange(span, passage.range, beforeRange));
        if (relevantSpans.length) relevant = true;
        passage = undoPassage(passage, beforeRange, relevantSpans);
        expectedHash = step.beforeHash;
      }
      if (!valid || expectedHash !== row.before_hash) {
        passage = afterPassage;
        expectedHash = afterHash;
        chainComplete = false;
        break;
      }
      if (relevant) {
        if (openEntry && (canMergeIntoEntry(openEntry, row) || hasSameSelectionContent(openEntry, afterPassage))) {
          mergeSelectionHistoryEntry(openEntry, row);
        } else {
          if (openEntry) {
            entries.push(stripEntryMetadata(openEntry));
            if (entries.length >= limit) {
              const preview = previewPassage(afterPassage.exact ? afterPassage.text : null);
              baseline = { content: preview.text, contentTruncated: preview.truncated };
              exhaustedRows = false;
              break;
            }
          }
          openEntry = createSelectionHistoryEntry(row, afterPassage);
        }
      }
    }
    if (openEntry && entries.length < limit) entries.push(stripEntryMetadata(openEntry));
    if (chainComplete && exhaustedRows && this.reachedRetentionBoundary(projectId, filePath, expectedHash)) {
      chainComplete = false;
    }
    if (exhaustedRows && entries.length) {
      const preview = previewPassage(passage.exact ? passage.text : null);
      baseline = { content: preview.text, contentTruncated: preview.truncated };
    }
    return { entries, baseline, hasMore: !exhaustedRows, chainComplete };
  }

  private reachedRetentionBoundary(projectId: string, filePath: string, expectedHash: string): boolean {
    const row = this.db.prepare(`SELECT after_hash FROM project_edit_history_boundaries
      WHERE project_id = ? AND file_path = ?`).get(projectId, filePath) as { after_hash?: string } | undefined;
    return row?.after_hash === expectedHash;
  }
}

interface TextRange { start: number; end: number }

function createSelectionHistoryEntry(
  row: EditHistoryRow,
  afterPassage: PassageState
): OpenSelectionHistoryEntry {
  const content = previewPassage(afterPassage.exact ? afterPassage.text : null);
  return {
    id: row.id,
    filePath: row.file_path,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    authorKeys: new Set([authorKey(row)]),
    authors: [authorFromRow(row)],
    content: content.text,
    contentTruncated: content.truncated
  };
}

function canMergeIntoEntry(entry: OpenSelectionHistoryEntry, row: EditHistoryRow): boolean {
  const latest = Date.parse(entry.updatedAt);
  const current = Date.parse(row.updated_at);
  return Number.isFinite(latest) && Number.isFinite(current)
    && latest >= current && latest - current <= EDIT_SESSION_GAP_MS;
}

/**
 * A history row can be relevant because it moved a selection boundary even
 * when the reconstructed selected text did not change. Do not make users
 * page through duplicate states: retain one block, but aggregate its time and
 * contributors. Truncated or inexact text is deliberately never treated as
 * equal.
 */
function hasSameSelectionContent(entry: OpenSelectionHistoryEntry, passage: PassageState): boolean {
  const candidate = previewPassage(passage.exact ? passage.text : null);
  return entry.content !== null && !entry.contentTruncated
    && candidate.text !== null && !candidate.truncated
    && entry.content === candidate.text;
}

function mergeSelectionHistoryEntry(
  entry: OpenSelectionHistoryEntry,
  row: EditHistoryRow
): void {
  entry.createdAt = row.created_at;
  if (!entry.authorKeys.has(authorKey(row))) {
    entry.authorKeys.add(authorKey(row));
    entry.authors.push(authorFromRow(row));
  }
}

function stripEntryMetadata(entry: OpenSelectionHistoryEntry): SelectionHistoryEntry {
  const { authorKeys: _authorKeys, ...result } = entry;
  return result;
}

function authorFromRow(row: EditHistoryRow): SelectionHistoryAuthor {
  return row.author_id && row.author_username && row.author_name
    ? { id: row.author_id, username: row.author_username, name: row.author_name }
    : { id: null, username: null, name: null };
}

function authorKey(row: EditHistoryRow): string {
  return row.author_id ?? "<deleted>";
}

/**
 * Reconstruct just the selected passage while walking a Yjs step backwards.
 * We avoid rebuilding the full source tree and abandon the exact passage only
 * when a deliberately truncated stored preview makes reconstruction unsafe.
 */
function undoPassage(current: PassageState, beforeRange: TextRange, spans: readonly EditHistorySpan[]): PassageState {
  if (!spans.length) return { ...current, range: beforeRange, exact: current.exact && current.text.length === beforeRange.end - beforeRange.start };
  let text = current.text;
  let exact = current.exact;
  for (const span of [...spans].sort((left, right) => right.afterStart - left.afterStart || right.afterEnd - left.afterEnd)) {
    if (span.truncated || span.deletedPreview.length !== span.deletedLength || span.insertedPreview.length !== span.insertedLength) {
      exact = false;
      continue;
    }
    if (span.insertedLength === 0) {
      const position = clamp(span.afterStart - current.range.start, 0, text.length);
      text = `${text.slice(0, position)}${span.deletedPreview}${text.slice(position)}`;
      continue;
    }
    const start = clamp(Math.max(span.afterStart, current.range.start) - current.range.start, 0, text.length);
    const end = clamp(Math.min(span.afterEnd, current.range.end) - current.range.start, start, text.length);
    text = `${text.slice(0, start)}${span.deletedPreview}${text.slice(end)}`;
  }
  if (exact && text.length !== beforeRange.end - beforeRange.start) exact = false;
  return { range: beforeRange, text, exact };
}

function previewPassage(value: string | null): { text: string | null; truncated: boolean } {
  if (value === null) return { text: null, truncated: false };
  if (value.length <= MAX_PASSAGE_PREVIEW_CHARS) return { text: value, truncated: false };
  const edge = Math.floor((MAX_PASSAGE_PREVIEW_CHARS - 1) / 2);
  return { text: `${value.slice(0, edge)}…${value.slice(value.length - edge)}`, truncated: true };
}

export function hashText(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function normalizeSegment(input: EditHistorySegmentInput): EditHistorySegmentInput | null {
  if (!input.authorId || !input.steps.length) return null;
  let filePath: string;
  try { filePath = safeRelativePath(input.filePath); }
  catch { return null; }
  const steps = input.steps.map(normalizeStep).filter((step): step is EditHistoryStep => step !== null);
  if (!steps.length) return null;
  const first = steps[0];
  const last = steps.at(-1)!;
  if (input.beforeHash !== first.beforeHash || input.afterHash !== last.afterHash) return null;
  for (let index = 1; index < steps.length; index += 1) {
    if (steps[index - 1].afterHash !== steps[index].beforeHash) return null;
  }
  return {
    filePath,
    authorId: input.authorId,
    kind: input.kind === "format" ? "format" : "edit",
    beforeHash: input.beforeHash,
    afterHash: input.afterHash,
    createdAt: safeTimestamp(input.createdAt),
    updatedAt: safeTimestamp(input.updatedAt),
    steps
  };
}

function normalizeStep(step: EditHistoryStep): EditHistoryStep | null {
  if (!isHash(step.beforeHash) || !isHash(step.afterHash)) return null;
  const spans = step.spans.map(normalizeSpan).filter((span): span is EditHistorySpan => span !== null);
  return spans.length ? { beforeHash: step.beforeHash, afterHash: step.afterHash, createdAt: safeTimestamp(step.createdAt), spans } : null;
}

function normalizeSpan(span: EditHistorySpan): EditHistorySpan | null {
  const numeric = [span.beforeStart, span.beforeEnd, span.afterStart, span.afterEnd, span.deletedLength, span.insertedLength];
  if (numeric.some((value) => !Number.isInteger(value) || value < 0)
    || span.beforeEnd < span.beforeStart || span.afterEnd < span.afterStart
    || span.deletedLength !== span.beforeEnd - span.beforeStart
    || span.insertedLength !== span.afterEnd - span.afterStart) return null;
  return {
    beforeStart: span.beforeStart,
    beforeEnd: span.beforeEnd,
    afterStart: span.afterStart,
    afterEnd: span.afterEnd,
    deletedLength: span.deletedLength,
    insertedLength: span.insertedLength,
    deletedPreview: typeof span.deletedPreview === "string" ? span.deletedPreview.slice(0, 4_096) : "",
    insertedPreview: typeof span.insertedPreview === "string" ? span.insertedPreview.slice(0, 4_096) : "",
    truncated: Boolean(span.truncated)
  };
}

function parseSteps(input: string): EditHistoryStep[] {
  try {
    const parsed = JSON.parse(input);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(normalizeStep).filter((step): step is EditHistoryStep => step !== null);
  } catch {
    return [];
  }
}

function mapRangeBackward(range: TextRange, spans: readonly EditHistorySpan[]): TextRange {
  return {
    start: mapPositionBackward(range.start, spans, -1),
    end: mapPositionBackward(range.end, spans, 1)
  };
}

/** Map a position from a step's post-edit document back to its pre-edit document. */
function mapPositionBackward(position: number, spans: readonly EditHistorySpan[], association: -1 | 1): number {
  let delta = 0;
  for (const span of spans) {
    // Nonempty replacements have unambiguous endpoints. Association only
    // chooses a side inside a replacement or at a collapsed deletion.
    if (span.insertedLength > 0 && position === span.afterStart) return span.beforeStart;
    if (span.insertedLength > 0 && position === span.afterEnd) return span.beforeEnd;
    if (position < span.afterStart || (position === span.afterStart && association < 0)) return position + delta;
    if (position > span.afterEnd || (position === span.afterEnd && association > 0)) {
      delta += span.deletedLength - span.insertedLength;
      continue;
    }
    return span.beforeStart + (association < 0 ? 0 : span.deletedLength);
  }
  return position + delta;
}

function spanIntersectsRange(span: EditHistorySpan, after: TextRange, before: TextRange): boolean {
  if (rangesIntersect(after.start, after.end, span.afterStart, span.afterEnd)) return true;
  // A deletion has no surviving post-edit range, so the mapped pre-edit
  // selection is its only reliable signal. For replacements and insertions,
  // checking the pre-edit range as well would falsely include a change that
  // merely touches the selection's right boundary.
  return span.insertedLength === 0 && rangesIntersect(before.start, before.end, span.beforeStart, span.beforeEnd);
}

function rangesIntersect(leftStart: number, leftEnd: number, rightStart: number, rightEnd: number): boolean {
  if (leftStart === leftEnd) return leftStart >= rightStart && leftStart <= rightEnd;
  if (rightStart === rightEnd) return rightStart >= leftStart && rightStart <= leftEnd;
  return leftStart < rightEnd && rightStart < leftEnd;
}

function safeTimestamp(value: string): string {
  return Number.isNaN(Date.parse(value)) ? new Date().toISOString() : value;
}

function isHash(value: string): boolean {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
}

function normalizeStorageLimit(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_EDIT_HISTORY_MAX_STORAGE_BYTES;
  return Math.floor(value);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Number.isFinite(value) ? Math.floor(value) : min));
}
