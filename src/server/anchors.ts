import { makeDiff } from "@sanity/diff-match-patch";
import type { DatabaseConnection } from "./db.js";
import { cleanupTextDiff } from "../shared/textDiff.js";
import { anchorSource, mapSourceAnchor, sourceAnchorAt, type AnchorChange } from "../shared/sourceCommentAnchors.js";
export type { SourceAnchor } from "../shared/sourceCommentAnchors.js";
import type { SourceAnchor } from "../shared/sourceCommentAnchors.js";

interface AnchorRow {
  id: string;
  selected_text: string;
  start_offset: number;
  end_offset: number;
  context_before: string;
  context_after: string;
  orphaned: number;
}

/** Actual edits, rather than a guessed diff; each batch uses its prior text's coordinates. */
export interface SourceCommentEdit extends AnchorChange { insert: string }

export function createSourceAnchor(source: string, startInput: number, endInput: number): SourceAnchor {
  return sourceAnchorAt(anchorSource(source), startInput, endInput);
}

export function reanchorFileComments(
  db: DatabaseConnection,
  projectId: string,
  filePath: string,
  oldSource: string,
  newSource: string,
  editBatches?: readonly (readonly SourceCommentEdit[])[]
): void {
  if (oldSource === newSource) return;
  const comments = db.prepare(`SELECT id, selected_text, start_offset, end_offset, context_before, context_after, orphaned
    FROM comments WHERE project_id = ? AND file_path = ?`).all(projectId, filePath) as unknown as AnchorRow[];
  if (!comments.length) return;
  // Validate the chain before using it. Disk/HTTP replacements have no Yjs
  // chain, and must fall back to comparing their before/after snapshots.
  const originalAnchors: SourceAnchor[] = comments.map((comment) => ({
    startOffset: comment.start_offset, endOffset: comment.end_offset,
    selectedText: comment.selected_text, contextBefore: comment.context_before,
    contextAfter: comment.context_after, orphaned: Boolean(comment.orphaned)
  }));
  let anchors = originalAnchors;
  let replayed = oldSource;
  for (const batch of editBatches ?? []) {
    let after = "";
    let cursor = 0;
    for (const edit of batch) {
      after += replayed.slice(cursor, edit.from) + edit.insert;
      cursor = edit.to;
    }
    after += replayed.slice(cursor);
    anchors = anchors.map((anchor) => mapSourceAnchor(anchor, anchorSource(replayed), anchorSource(after), batch));
    replayed = after;
  }
  if (!editBatches?.length || replayed !== newSource) {
    const diffs = cleanupTextDiff(makeDiff(oldSource, newSource, { checkLines: true, timeout: 1 }), "semantic");
    const changes: AnchorChange[] = [];
    let offset = 0;
    let pending: AnchorChange | null = null;
    for (const [kind, text] of diffs) {
      if (kind === 0) {
        if (pending) changes.push(pending);
        pending = null;
        offset += text.length;
      } else {
        pending ??= { from: offset, to: offset, insertLength: 0, inferred: true };
        if (kind === -1) { offset += text.length; pending.to = offset; }
        else pending.insertLength += text.length;
      }
    }
    if (pending) changes.push(pending);
    anchors = originalAnchors.map((anchor) => mapSourceAnchor(anchor, anchorSource(oldSource), anchorSource(newSource), changes));
  }
  const update = db.prepare(`UPDATE comments SET selected_text = ?, start_offset = ?, end_offset = ?,
    context_before = ?, context_after = ?, orphaned = ?, updated_at = ? WHERE id = ?`);

  db.transaction(() => {
    for (const [index, comment] of comments.entries()) {
      const anchor = anchors[index]!;
      update.run(
        anchor.selectedText, anchor.startOffset, anchor.endOffset,
        anchor.contextBefore, anchor.contextAfter, Number(anchor.orphaned), new Date().toISOString(), comment.id
      );
    }
  })();
}

export function offsetToLine(source: string, offsetInput: number): number {
  const offset = Math.max(0, Math.min(source.length, Number.isFinite(offsetInput) ? Math.floor(offsetInput) : 0));
  let line = 1;
  for (let index = 0; index < offset; index += 1) if (source.charCodeAt(index) === 10) line += 1;
  return line;
}
