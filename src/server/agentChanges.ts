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
    return [{ ...change, anchor: mapPosition(change.anchor, spans, "end") }];
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

function describe(group: readonly Located[], content: string): AgentChange {
  const from = group[0].start;
  const to = Math.max(...group.map((change) => change.end));
  const lineStart = content.lastIndexOf("\n", from - 1) + 1;
  const newline = content.indexOf("\n", to);
  const lineEnd = newline < 0 ? content.length : newline;
  const after = lineEnd - lineStart <= MAX_AGENT_CHANGE_PREVIEW_CHARS ? content.slice(lineStart, lineEnd) : null;
  return {
    id: group[0].id,
    ids: group.map((change) => change.id),
    at: group.reduce((latest, change) => change.at > latest ? change.at : latest, group[0].at),
    from,
    to,
    line: lineAndColumnAt(content, from).line,
    pieces: group.flatMap((change) => change.pieces),
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
