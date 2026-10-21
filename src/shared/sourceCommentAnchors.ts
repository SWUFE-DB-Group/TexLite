/** Persistent quote/context anchors, shared by source saves and live editor changes. */
export interface SourceAnchor {
  startOffset: number;
  endOffset: number;
  selectedText: string;
  contextBefore: string;
  contextAfter: string;
  orphaned: boolean;
}

export interface AnchorSource {
  length: number;
  sliceString(from: number, to: number): string;
}

/** Sorted, non-overlapping changes in the old document's coordinates. */
export interface AnchorChange {
  from: number;
  to: number;
  insertLength: number;
  /** A text-only diff can mistake a coincidental shared character for retained source. */
  inferred?: boolean;
}

interface AnchorSearchRange { from: number; to: number }

const CONTEXT_SIZE = 48;

export function anchorSource(source: string): AnchorSource {
  return { length: source.length, sliceString: (from, to) => source.slice(from, to) };
}

export function sourceAnchorAt(source: AnchorSource, start: number, end: number): SourceAnchor {
  const startOffset = clamp(Math.min(start, end), 0, source.length);
  const endOffset = clamp(Math.max(start, end), startOffset, source.length);
  return {
    startOffset, endOffset,
    selectedText: source.sliceString(startOffset, endOffset),
    contextBefore: source.sliceString(Math.max(0, startOffset - CONTEXT_SIZE), startOffset),
    contextAfter: source.sliceString(endOffset, Math.min(source.length, endOffset + CONTEXT_SIZE)),
    orphaned: false
  };
}

function mappedOffset(position: number, changes: readonly AnchorChange[], side: -1 | 1): number {
  let delta = 0;
  for (const change of changes) {
    if (position < change.from) break;
    if (position > change.to || position === change.to && change.to > change.from) {
      delta += change.insertLength - (change.to - change.from);
    } else {
      return change.from + delta + (side > 0 ? change.insertLength : 0);
    }
  }
  return position + delta;
}

/**
 * Follow partial edits, but keep the last attached quote and context when the
 * selection is erased or no longer recognizable. They are required for undo
 * recovery; the mapped range alone is just a positional hint while detached.
 * Recovery candidates must have been formed by the current changes, so an
 * unchanged duplicate cannot inherit a deleted selection's discussion.
 * A browser may bound recovery searches near the hint to avoid flattening the
 * entire CodeMirror document on each keystroke.
 */
export function mapSourceAnchor(
  anchor: SourceAnchor,
  oldSource: AnchorSource,
  newSource: AnchorSource,
  changes: readonly AnchorChange[],
  recoveryWindow?: number
): SourceAnchor {
  const oldStart = clamp(anchor.startOffset, 0, oldSource.length);
  const oldEnd = clamp(anchor.endOffset, oldStart, oldSource.length);
  const deletions = changes.filter((change) => change.from < oldEnd && change.to > oldStart);
  // Replacements touching the selection's boundaries belong to the range.
  // Pure insertions just outside it do not (typing before/after a quote).
  const startSide = deletions.some((change) => change.from <= oldStart) ? -1 : 1;
  const endSide = deletions.some((change) => change.to >= oldEnd) ? 1 : -1;
  const start = clamp(mappedOffset(oldStart, changes, startSide), 0, newSource.length);
  const end = clamp(mappedOffset(oldEnd, changes, endSide), start, newSource.length);
  const oldMatches = oldSource.sliceString(oldStart, oldEnd) === anchor.selectedText;

  if (!anchor.orphaned && oldMatches) {
    if (!anchor.selectedText && oldStart === oldEnd) return sourceAnchorAt(newSource, start, start);
    const deletedLength = deletions.reduce((sum, change) => sum + Math.min(oldEnd, change.to) - Math.max(oldStart, change.from), 0);
    const retainedLength = oldEnd - oldStart - deletedLength;
    // Exact editor operations can retain even one original character.
    // A guessed text diff needs stronger evidence for word replacements.
    const minimumRetained = changes.some((change) => change.inferred) ? Math.min(2, oldEnd - oldStart) : 1;
    if (end > start && retainedLength >= minimumRetained) {
      return sourceAnchorAt(newSource, start, end);
    }
  }

  const detached = { ...anchor, startOffset: start, endOffset: end, orphaned: true };
  // Do not silently legitimize a previously attached but stale DB row whose
  // quote didn't match the old document in the first place.
  if (!anchor.orphaned && !oldMatches) return detached;
  const restored = contextualMatch(newSource, anchor, start, changedSourceRanges(changes), recoveryWindow);
  return restored === null ? detached : sourceAnchorAt(newSource, restored, restored + anchor.selectedText.length);
}

/** New-document coordinates, including deletion points that can rejoin a quote. */
function changedSourceRanges(changes: readonly AnchorChange[]): AnchorSearchRange[] {
  let delta = 0;
  const ranges: AnchorSearchRange[] = [];
  for (const change of changes) {
    if (change.to > change.from || change.insertLength > 0) {
      const from = change.from + delta;
      ranges.push({ from, to: from + change.insertLength });
    }
    delta += change.insertLength - (change.to - change.from);
  }
  return ranges;
}

function contextualMatch(source: AnchorSource, anchor: SourceAnchor, start: number, changedRanges: readonly AnchorSearchRange[], window?: number): number | null {
  const selected = anchor.selectedText;
  if (!selected) return null;
  const availableContext = anchor.contextBefore.length + anchor.contextAfter.length;
  // A whole-file selection has no context. Only an exact whole-file undo is
  // safe; it can also be completed by deleting an unwanted prefix/suffix.
  if (!availableContext) return selected.length === source.length && source.sliceString(0, source.length) === selected ? 0 : null;
  if (!changedRanges.length) return null;
  const from = window === undefined ? 0 : Math.max(0, start - selected.length - window);
  const to = window === undefined ? source.length : Math.min(source.length, start + selected.length + window);
  // Whole-document undo/paste may restore a quote far from the collapsed
  // hint. Inspect the inserted fragment in that case, not the whole file on
  // each subsequent small edit while the comment remains detached.
  const ranges = window === undefined ? [{ from, to }] : [{ from, to },
    ...changedRanges.filter((range) => range.to - range.from >= selected.length)];
  const seen = new Set<number>();
  let best: number | null = null;
  let bestRank = Number.NEGATIVE_INFINITY;
  let tied = false;
  for (const range of ranges) {
    const search = source.sliceString(range.from, range.to);
    for (let cursor = 0; cursor <= search.length;) {
      const index = search.indexOf(selected, cursor);
      if (index < 0) break;
      const found = range.from + index;
      cursor = index + Math.max(1, selected.length);
      if (seen.has(found)) continue;
      seen.add(found);
      const end = found + selected.length;
      // An insertion/replacement must overlap the quote. A pure deletion
      // must fall strictly inside it: deleting the first of two adjacent
      // copies must not attach its comment to the surviving second copy.
      if (!changedRanges.some((change) => change.from === change.to
        ? found < change.from && change.from < end
        : found < change.to && end > change.from)) continue;
      const before = source.sliceString(Math.max(0, found - anchor.contextBefore.length), found);
      const after = source.sliceString(found + selected.length, Math.min(source.length, found + selected.length + anchor.contextAfter.length));
      const contextScore = commonSuffixLength(before, anchor.contextBefore) + commonPrefixLength(after, anchor.contextAfter);
      if (contextScore >= Math.min(4, availableContext)) {
        const rank = contextScore * 1000 - Math.abs(found - start);
        if (rank > bestRank) { best = found; bestRank = rank; tied = false; }
        else if (rank === bestRank) tied = true;
      }
    }
  }
  return tied ? null : best;
}

function commonPrefixLength(left: string, right: string): number {
  let index = 0;
  while (index < Math.min(left.length, right.length) && left[index] === right[index]) index++;
  return index;
}

function commonSuffixLength(left: string, right: string): number {
  let count = 0;
  while (count < Math.min(left.length, right.length) && left[left.length - count - 1] === right[right.length - count - 1]) count++;
  return count;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Number.isFinite(value) ? Math.floor(value) : min));
}
