import type { AgentChange, AgentChangeRange } from "../shared/agentProtocol.js";
import type { EditHistorySpan } from "./editHistory.js";
import { lineAndColumnAt } from "../shared/latexReferences.js";

/**
 * Coding-agent changes, mapped to the current source.
 *
 * The edit-history chain already holds every replacement with its complete
 * deleted and inserted text, in order, and marks the ones a coding agent
 * wrote. Walking the chain forward from an agent replacement to the current
 * source gives the agent's text as it stands now: anything a later edit
 * replaced is dropped from the range, so a person editing that text removes
 * its highlight without any extra bookkeeping. Nothing is stored for this;
 * review state lives in the browser.
 */

/** One edit step of the chain, oldest first. */
export interface AgentChangeStep {
  /** Stable id of the step: segment id plus step index. */
  id: string;
  /** The step was written by a coding agent for the requesting user. */
  agent: boolean;
  createdAt: string;
  spans: readonly EditHistorySpan[];
}

/** Grouped changes larger than this have no line diff preview. */
export const MAX_AGENT_CHANGE_PREVIEW_CHARS = 8_000;
/** Replacements from one write this close together are reviewed as one change. */
const GROUP_GAP_CHARS = 80;

interface TrackedChange {
  id: string;
  stepId: string;
  at: string;
  deleted: string;
  inserted: string;
  pieces: AgentChangeRange[];
  /** Position of a pure deletion; null for a replacement or insertion. */
  anchor: number | null;
  /** Someone later inserted text at this deletion, so its preview would be wrong. */
  touched?: boolean;
}

export function collectAgentChanges(steps: readonly AgentChangeStep[], content: string): AgentChange[] {
  let tracked: TrackedChange[] = [];
  for (const step of steps) {
    const spans = [...step.spans].sort((left, right) => left.beforeStart - right.beforeStart || left.beforeEnd - right.beforeEnd);
    tracked = tracked.flatMap((change) => mapChange(change, spans));
    if (!step.agent) continue;
    spans.forEach((span, index) => {
      // Historical rows may hold shortened text; such a change cannot be
      // previewed or reconstructed, but its surviving range is still exact.
      tracked.push({
        id: `${step.id}:${index}`,
        stepId: step.id,
        at: step.createdAt,
        deleted: span.truncated ? "" : span.deletedPreview,
        inserted: span.truncated ? "" : span.insertedPreview,
        pieces: span.insertedLength > 0 ? [{ from: span.afterStart, to: span.afterEnd }] : [],
        anchor: span.insertedLength > 0 ? null : span.afterStart
      });
    });
  }
  return groupChanges(tracked.filter((change) => inBounds(change, content.length)), content);
}

function inBounds(change: TrackedChange, length: number): boolean {
  return change.anchor !== null
    ? change.anchor >= 0 && change.anchor <= length
    : change.pieces.every((piece) => piece.from >= 0 && piece.to <= length && piece.from < piece.to);
}

/** Map one tracked change through a later step, or drop it when nothing of it survives. */
function mapChange(change: TrackedChange, spans: readonly EditHistorySpan[]): TrackedChange[] {
  if (change.anchor !== null) {
    // A later replacement across a deletion point rewrote that text.
    if (spans.some((span) => span.beforeEnd > span.beforeStart && span.beforeStart < change.anchor! && change.anchor! < span.beforeEnd)) return [];
    const insertion = spans.find((span) => span.beforeStart === change.anchor && span.beforeEnd === change.anchor && span.insertedLength > 0);
    // The deleted text was put back exactly, so nothing is left to review.
    if (insertion && change.deleted && !insertion.truncated && insertion.insertedPreview === change.deleted) return [];
    return [{ ...change, anchor: mapPosition(change.anchor, spans, "end"), touched: change.touched || Boolean(insertion) }];
  }
  const pieces = change.pieces.flatMap((piece) => mapRange(piece, spans));
  return pieces.length ? [{ ...change, pieces }] : [];
}

/** Surviving parts of a range: text a step replaced, and text it inserted inside, are not the agent's. */
export function mapRange(range: AgentChangeRange, spans: readonly EditHistorySpan[]): AgentChangeRange[] {
  let pieces: AgentChangeRange[] = [range];
  for (const span of spans) {
    if (span.beforeEnd > span.beforeStart) {
      pieces = pieces.flatMap((piece) => {
        if (span.beforeEnd <= piece.from || span.beforeStart >= piece.to) return [piece];
        const kept: AgentChangeRange[] = [];
        if (span.beforeStart > piece.from) kept.push({ from: piece.from, to: span.beforeStart });
        if (span.beforeEnd < piece.to) kept.push({ from: span.beforeEnd, to: piece.to });
        return kept;
      });
    } else {
      const at = span.beforeStart;
      pieces = pieces.flatMap((piece) => piece.from < at && at < piece.to
        ? [{ from: piece.from, to: at }, { from: at, to: piece.to }]
        : [piece]);
    }
  }
  return pieces
    .map((piece) => ({ from: mapPosition(piece.from, spans, "start"), to: mapPosition(piece.to, spans, "end") }))
    .filter((piece) => piece.to > piece.from);
}

/**
 * Map a position outside every replaced range from a step's pre-edit source
 * to its post-edit source. An insertion exactly at the position belongs
 * before a range's start and after a range's end, so it is never included.
 */
export function mapPosition(position: number, spans: readonly EditHistorySpan[], side: "start" | "end"): number {
  let mapped = position;
  for (const span of spans) {
    const before = span.beforeEnd < position
      || (span.beforeEnd === position && (span.beforeEnd > span.beforeStart || side === "start"));
    if (!before) break;
    mapped = position - span.beforeEnd + span.afterEnd;
  }
  return mapped;
}

interface Located extends TrackedChange { start: number; end: number }

function groupChanges(changes: readonly TrackedChange[], content: string): AgentChange[] {
  const located: Located[] = changes.map((change) => {
    const start = change.anchor ?? Math.min(...change.pieces.map((piece) => piece.from));
    const end = change.anchor ?? Math.max(...change.pieces.map((piece) => piece.to));
    return { ...change, start, end };
  }).sort((left, right) => left.start - right.start || left.end - right.end);
  const groups: Located[][] = [];
  for (const change of located) {
    const group = groups.at(-1);
    const last = group?.at(-1);
    if (group && last && last.stepId === change.stepId && change.start >= last.end) {
      const gap = content.slice(last.end, change.start);
      if (gap.length <= GROUP_GAP_CHARS && !gap.includes("\n\n")) {
        group.push(change);
        continue;
      }
    }
    groups.push([change]);
  }
  return groups.map((group) => describe(group, content));
}

/** Letters and digits of scripts written with spaces; a CJK run is not one word. */
const WORD_CHARACTER = /(?![\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}])[\p{L}\p{N}]/u;

interface DisplayPiece extends AgentChangeRange { intact: boolean }

/**
 * Highlighted ranges. A character diff keeps letters that a rewrite happens to
 * share, so "paper" can come back as "p", "ape" and "r". Text that still stands
 * as written is shown in whole words, joined across plain spaces; text a later
 * edit trimmed keeps its exact surviving ranges.
 */
function displayPieces(group: readonly Located[], content: string): AgentChangeRange[] {
  const pieces: DisplayPiece[] = group.flatMap((change) => {
    const intact = change.pieces.length === 1 && change.inserted.length > 0
      && content.slice(change.pieces[0].from, change.pieces[0].to) === change.inserted;
    return change.pieces.map((piece) => {
      if (!intact) return { ...piece, intact };
      let { from, to } = piece;
      if (WORD_CHARACTER.test(content[from])) while (from > 0 && WORD_CHARACTER.test(content[from - 1])) from -= 1;
      if (WORD_CHARACTER.test(content[to - 1])) while (to < content.length && WORD_CHARACTER.test(content[to])) to += 1;
      return { from, to, intact };
    });
  }).sort((left, right) => left.from - right.from);
  const merged: DisplayPiece[] = [];
  for (const piece of pieces) {
    const last = merged.at(-1);
    if (last && (piece.from <= last.to || (last.intact && piece.intact && /^[ \t]+$/.test(content.slice(last.to, piece.from))))) {
      last.to = Math.max(last.to, piece.to);
      last.intact &&= piece.intact;
    } else merged.push({ ...piece });
  }
  return merged.map(({ from, to }) => ({ from, to }));
}

function describe(group: readonly Located[], content: string): AgentChange {
  const start = group[0].start;
  const end = Math.max(...group.map((change) => change.end));
  // lastIndexOf treats -1 as 0, and would find a newline at the very start.
  const lineStart = start === 0 ? 0 : content.lastIndexOf("\n", start - 1) + 1;
  const pieces = displayPieces(group, content);
  const from = Math.min(start, pieces[0]?.from ?? start);
  const to = Math.max(end, pieces.at(-1)?.to ?? end);
  const newline = content.indexOf("\n", end);
  const lineEnd = newline < 0 ? content.length : newline;
  const after = lineEnd - lineStart <= MAX_AGENT_CHANGE_PREVIEW_CHARS ? content.slice(lineStart, lineEnd) : null;
  return {
    id: group[0].id,
    ids: group.map((change) => change.id),
    at: group.reduce((latest, change) => change.at > latest ? change.at : latest, group[0].at),
    from,
    to,
    line: lineAndColumnAt(content, start).line,
    pieces,
    anchors: group.flatMap((change) => change.anchor === null ? [] : [change.anchor]),
    before: after === null ? null : reconstructBefore(group, after, lineStart),
    after,
    afterFrom: lineStart
  };
}

/**
 * The affected lines as they were before the agent's write. Only exact when
 * every replacement still stands as written; otherwise later edits are mixed
 * in and no preview is offered rather than a misleading one.
 */
function reconstructBefore(group: readonly Located[], after: string, offset: number): string | null {
  let before = after;
  for (const change of [...group].reverse()) {
    if (change.anchor !== null) {
      if (change.touched) return null;
      before = before.slice(0, change.anchor - offset) + change.deleted + before.slice(change.anchor - offset);
      continue;
    }
    const [piece] = change.pieces;
    if (change.pieces.length !== 1 || piece.to - piece.from !== change.inserted.length
      || after.slice(piece.from - offset, piece.to - offset) !== change.inserted) return null;
    before = before.slice(0, piece.from - offset) + change.deleted + before.slice(piece.to - offset);
  }
  return before;
}

/**
 * The editor always holds "\n" line endings, whatever the file has on disk.
 * Express results in the text the editor holds, so that revisions compare equal
 * and offsets land on the same characters.
 */
export function normalizeAgentChangeLineEndings(changes: readonly AgentChange[], content: string): { source: string; changes: readonly AgentChange[] } {
  if (!content.includes("\r")) return { source: content, changes };
  const removed: number[] = [];
  for (let index = content.indexOf("\r\n"); index >= 0; index = content.indexOf("\r\n", index + 2)) removed.push(index);
  const position = (offset: number) => {
    let low = 0;
    let high = removed.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (removed[middle] < offset) low = middle + 1; else high = middle;
    }
    return offset - low;
  };
  const source = content.replace(/\r\n?/g, "\n");
  // A preview ends where the line's "\n" begins, which can leave its "\r" behind.
  const preview = (value: string | null) => value?.replace(/\r$/, "").replace(/\r\n?/g, "\n") ?? null;
  return {
    source,
    changes: changes.map((change) => ({
      ...change,
      from: position(change.from),
      to: position(change.to),
      line: lineAndColumnAt(source, position(change.from)).line,
      pieces: change.pieces.map((piece) => ({ from: position(piece.from), to: position(piece.to) })),
      anchors: change.anchors.map(position),
      before: preview(change.before),
      after: preview(change.after),
      afterFrom: position(change.afterFrom)
    }))
  };
}
