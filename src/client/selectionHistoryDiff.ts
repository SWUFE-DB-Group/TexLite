import diff_match_patch from "diff-match-patch";

export type SelectionHistoryDiffPieceKind = "equal" | "addition" | "deletion" | "omitted";

export interface SelectionHistoryDiffPiece {
  kind: SelectionHistoryDiffPieceKind;
  text: string;
}

export interface SelectionHistorySemanticDiff {
  /** The older selection, with removed text highlighted. */
  previous: SelectionHistoryDiffPiece[];
  /** The newer selection, with inserted text highlighted. */
  current: SelectionHistoryDiffPiece[];
  additions: number;
  deletions: number;
  hasChanges: boolean;
}

const EDGE_CONTEXT_CHARS = 96;
const MIDDLE_CONTEXT_CHARS = 48;

/**
 * Produce a compact, character-level comparison for a selected passage.
 *
 * Project and Git history intentionally retain the conventional line-oriented
 * unified diff. A selected LaTeX passage is often one very long paragraph or
 * command, though, so repeating all unchanged text makes the actual rewrite
 * difficult to find. This view keeps semantic diff-match-patch boundaries and
 * trims only long equal runs around the changed fragments.
 */
export function generateSelectionHistoryDiff(previousSource: string, currentSource: string): SelectionHistorySemanticDiff {
  const previousText = previousSource.replace(/\r\n/g, "\n");
  const currentText = currentSource.replace(/\r\n/g, "\n");
  if (previousText === currentText) {
    return { previous: [], current: [], additions: 0, deletions: 0, hasChanges: false };
  }

  const dmp = new diff_match_patch();
  const diffs = dmp.diff_main(previousText, currentText, false);
  dmp.diff_cleanupSemantic(diffs);

  const previous: SelectionHistoryDiffPiece[] = [];
  const current: SelectionHistoryDiffPiece[] = [];
  let additions = 0;
  let deletions = 0;

  for (let index = 0; index < diffs.length; index += 1) {
    const [operation, text] = diffs[index]!;
    if (!text) continue;
    if (operation === 0) {
      const compact = compactEqualContext(text, index, diffs.length);
      appendPiece(previous, compact);
      appendPiece(current, compact);
    } else if (operation < 0) {
      deletions += text.length;
      appendPiece(previous, { kind: "deletion", text });
    } else {
      additions += text.length;
      appendPiece(current, { kind: "addition", text });
    }
  }

  return { previous, current, additions, deletions, hasChanges: additions > 0 || deletions > 0 };
}

function compactEqualContext(text: string, index: number, total: number): SelectionHistoryDiffPiece {
  const isLeading = index === 0;
  const isTrailing = index === total - 1;
  if ((isLeading || isTrailing) && text.length <= EDGE_CONTEXT_CHARS) {
    return { kind: "equal", text };
  }
  if (!isLeading && !isTrailing && text.length <= MIDDLE_CONTEXT_CHARS * 2) {
    return { kind: "equal", text };
  }

  if (isLeading) {
    return { kind: "omitted", text: `…${tailContext(text, EDGE_CONTEXT_CHARS)}` };
  }
  if (isTrailing) {
    return { kind: "omitted", text: `${headContext(text, EDGE_CONTEXT_CHARS)}…` };
  }
  return {
    kind: "omitted",
    text: `${headContext(text, MIDDLE_CONTEXT_CHARS)}…${tailContext(text, MIDDLE_CONTEXT_CHARS)}`
  };
}

/** Prefer a word/line boundary while keeping the displayed context bounded. */
function headContext(text: string, length: number): string {
  if (text.length <= length) return text;
  const boundary = findForwardBoundary(text, length);
  return text.slice(0, boundary);
}

/** Prefer a word/line boundary while keeping the displayed context bounded. */
function tailContext(text: string, length: number): string {
  if (text.length <= length) return text;
  const boundary = findBackwardBoundary(text, text.length - length);
  return text.slice(boundary);
}

function findForwardBoundary(text: string, preferred: number): number {
  const limit = Math.min(text.length, preferred + 24);
  for (let index = preferred; index < limit; index += 1) {
    if (isBoundary(text[index]!)) return index + 1;
  }
  return preferred;
}

function findBackwardBoundary(text: string, preferred: number): number {
  const limit = Math.max(0, preferred - 24);
  for (let index = preferred; index > limit; index -= 1) {
    if (isBoundary(text[index - 1]!)) return index;
  }
  return preferred;
}

function isBoundary(value: string): boolean {
  return /\s|[.,;:!?)}\]]/.test(value);
}

function appendPiece(target: SelectionHistoryDiffPiece[], piece: SelectionHistoryDiffPiece): void {
  const previous = target.at(-1);
  if (previous?.kind === piece.kind) {
    previous.text += piece.text;
  } else {
    target.push({ ...piece });
  }
}
