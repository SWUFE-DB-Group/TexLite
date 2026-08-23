import diff_match_patch from "diff-match-patch";
import type { DatabaseConnection } from "./db.js";

interface AnchorRow {
  id: string;
  selected_text: string;
  start_offset: number;
  end_offset: number;
  context_before: string;
  context_after: string;
}

const CONTEXT_SIZE = 48;

export interface SourceAnchor {
  startOffset: number;
  endOffset: number;
  selectedText: string;
  contextBefore: string;
  contextAfter: string;
  orphaned: boolean;
}

export function createSourceAnchor(source: string, startInput: number, endInput: number): SourceAnchor {
  const startOffset = clamp(Math.min(startInput, endInput), 0, source.length);
  const endOffset = clamp(Math.max(startInput, endInput), startOffset, source.length);
  return anchorAt(source, startOffset, endOffset, false);
}

export function reanchorFileComments(
  db: DatabaseConnection,
  projectId: string,
  filePath: string,
  oldSource: string,
  newSource: string
): void {
  if (oldSource === newSource) return;
  const dmp = new diff_match_patch();
  const diffs = dmp.diff_main(oldSource, newSource, true);
  dmp.diff_cleanupSemantic(diffs);
  const comments = db.prepare(`SELECT id, selected_text, start_offset, end_offset, context_before, context_after
    FROM comments WHERE project_id = ? AND file_path = ?`).all(projectId, filePath) as unknown as AnchorRow[];
  const update = db.prepare(`UPDATE comments SET selected_text = ?, start_offset = ?, end_offset = ?,
    context_before = ?, context_after = ?, orphaned = ?, updated_at = ? WHERE id = ?`);

  for (const comment of comments) {
    const oldStart = clamp(comment.start_offset, 0, oldSource.length);
    const oldEnd = clamp(comment.end_offset, oldStart, oldSource.length);
    let start = clamp(dmp.diff_xIndex(diffs, oldStart), 0, newSource.length);
    let end = clamp(dmp.diff_xIndex(diffs, oldEnd), start, newSource.length);
    let orphaned = false;

    // A diff-mapped range is only trustworthy when it still contains the
    // exact text that the author selected. A replacement can preserve a
    // non-empty range while changing every character, which otherwise makes
    // a comment silently point at an unrelated piece of source.
    const hasSelectedRange = oldEnd > oldStart || comment.selected_text.length > 0;
    const originalTextMatches = !hasSelectedRange || oldSource.slice(oldStart, oldEnd) === comment.selected_text;
    if (hasSelectedRange && !originalTextMatches) {
      orphaned = true;
    } else if (hasSelectedRange && newSource.slice(start, end) !== comment.selected_text) {
      const relocated = nearestContextualMatch(
        newSource, comment.selected_text, start, comment.context_before, comment.context_after
      );
      if (relocated === null) {
        orphaned = true;
      } else {
        start = relocated;
        end = relocated + comment.selected_text.length;
      }
    }
    if (hasSelectedRange && !comment.selected_text) orphaned = true;

    const anchor = anchorAt(newSource, start, end, orphaned);
    update.run(
      orphaned ? comment.selected_text : anchor.selectedText, anchor.startOffset, anchor.endOffset,
      anchor.contextBefore, anchor.contextAfter, Number(anchor.orphaned), new Date().toISOString(), comment.id
    );
  }
}

export function offsetToLine(source: string, offsetInput: number): number {
  const offset = clamp(offsetInput, 0, source.length);
  let line = 1;
  for (let index = 0; index < offset; index += 1) if (source.charCodeAt(index) === 10) line += 1;
  return line;
}

function anchorAt(source: string, startOffset: number, endOffset: number, orphaned: boolean): SourceAnchor {
  return {
    startOffset,
    endOffset,
    selectedText: source.slice(startOffset, endOffset),
    contextBefore: source.slice(Math.max(0, startOffset - CONTEXT_SIZE), startOffset),
    contextAfter: source.slice(endOffset, Math.min(source.length, endOffset + CONTEXT_SIZE)),
    orphaned
  };
}

function nearestContextualMatch(
  source: string,
  selected: string,
  expected: number,
  contextBefore: string,
  contextAfter: string
): number | null {
  if (!selected) return null;
  let best: number | null = null;
  let bestRank = Number.NEGATIVE_INFINITY;
  let cursor = 0;
  while (cursor <= source.length) {
    const found = source.indexOf(selected, cursor);
    if (found < 0) break;
    const distance = Math.abs(found - expected);
    const before = source.slice(Math.max(0, found - contextBefore.length), found);
    const after = source.slice(found + selected.length, found + selected.length + contextAfter.length);
    const contextScore = commonSuffixLength(before, contextBefore) + commonPrefixLength(after, contextAfter);
    // Do not relocate based solely on proximity. A repeated word with no
    // matching context is ambiguous and must be surfaced as orphaned.
    const availableContext = contextBefore.length + contextAfter.length;
    if (availableContext === 0) return null;
    const minimumContext = Math.min(4, availableContext);
    if (contextScore < minimumContext) {
      cursor = found + Math.max(1, selected.length);
      continue;
    }
    const rank = contextScore * 1000 - distance;
    if (rank > bestRank) {
      best = found;
      bestRank = rank;
    }
    cursor = found + Math.max(1, selected.length);
  }
  return best;
}

function commonPrefixLength(left: string, right: string): number {
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (index < limit && left[index] === right[index]) index += 1;
  return index;
}

function commonSuffixLength(left: string, right: string): number {
  const limit = Math.min(left.length, right.length);
  let count = 0;
  while (count < limit && left[left.length - 1 - count] === right[right.length - 1 - count]) count += 1;
  return count;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Number.isFinite(value) ? Math.floor(value) : min));
}
