import { ApiError, api } from "./api";
import { clientUuid } from "./uuid";
import { supportsChktexChecks } from "../shared/writingChecks";
import type { SpellCheckIssue } from "./spellCheck";

export interface RawChktexLint {
  line: number;
  column: number;
  length: number;
  number: number | null;
  message: string;
}

export class ChktexLintSupersededError extends Error {
  constructor() {
    super("A newer ChkTeX check replaced this request.");
    this.name = "ChktexLintSupersededError";
  }
}

export function isChktexLintSupersededError(error: unknown): error is ChktexLintSupersededError {
  return error instanceof ChktexLintSupersededError;
}

const chktexClientId = clientUuid();
let chktexSequence = 0;

async function requestChktexLints(projectId: string, path: string, source: string, sequence: number): Promise<RawChktexLint[]> {
  try {
    const result = await api<{ issues: RawChktexLint[] }>(`/api/projects/${projectId}/chktex`, {
      method: "POST",
      body: JSON.stringify({ path, source, clientId: chktexClientId, sequence })
    });
    return result.issues;
  } catch (error) {
    if (error instanceof ApiError && error.code === "CHK_TEX_SUPERSEDED") throw new ChktexLintSupersededError();
    throw error;
  }
}

function utf8ByteOffsets(value: string): number[] {
  // ChkTeX reports columns in UTF-8 bytes, while CodeMirror uses UTF-16
  // offsets. Keep a boundary for every byte and map an interior multibyte
  // position to the end of that code point (ChkTeX never intentionally points
  // into one).
  const offsets = [0];
  const encoder = new TextEncoder();
  let utf16Offset = 0;
  for (const character of value) {
    const byteLength = encoder.encode(character).length;
    utf16Offset += character.length;
    for (let byte = 0; byte < byteLength; byte += 1) offsets.push(utf16Offset);
  }
  return offsets;
}

function lineStarts(source: string): number[] {
  const starts = [0];
  for (let index = 0; index < source.length; index += 1) if (source[index] === "\n") starts.push(index + 1);
  return starts;
}

/** Convert ChkTeX's one-based line/column coordinates to CodeMirror offsets. */
export function mapChktexLints(source: string, lints: RawChktexLint[]): SpellCheckIssue[] {
  const starts = lineStarts(source);
  const seen = new Set<string>();
  const lineOffsets = new Map<number, { start: number; line: string; offsets: number[] }>();
  const issues: SpellCheckIssue[] = [];
  for (const lint of lints) {
    const lineIndex = lint.line - 1;
    if (!Number.isSafeInteger(lineIndex) || lineIndex < 0 || lineIndex >= starts.length) continue;
    let mappedLine = lineOffsets.get(lineIndex);
    if (!mappedLine) {
      const start = starts[lineIndex] ?? 0;
      const newline = source.indexOf("\n", start);
      const lineEnd = newline === -1 ? source.length : newline;
      const line = source.slice(start, lineEnd);
      mappedLine = { start, line, offsets: utf8ByteOffsets(line) };
      lineOffsets.set(lineIndex, mappedLine);
    }
    const { start, line, offsets } = mappedLine;
    const byteColumn = lint.column - 1;
    // Ignore out-of-range coordinates rather than clamping them onto an
    // unrelated character (often the last line after a parser mismatch).
    if (!Number.isSafeInteger(byteColumn) || byteColumn < 0 || byteColumn >= offsets.length - 1) continue;
    const from = start + offsets[byteColumn];
    const byteEnd = Math.min(offsets.length - 1, byteColumn + Math.max(1, lint.length));
    const to = start + (offsets[byteEnd] ?? line.length);
    if (from >= source.length || to <= from) continue;
    const word = source.slice(from, Math.min(to, source.length));
    const key = `${from}:${to}:${lint.number ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    issues.push({
      from,
      to: Math.min(to, source.length),
      word,
      kind: "latex",
      message: lint.number === null ? `ChkTeX: ${lint.message}` : `ChkTeX ${lint.number}: ${lint.message}`,
      suggestions: []
    });
  }
  return issues.sort((left, right) => left.from - right.from || left.to - right.to);
}

export async function lintChktex(projectId: string, path: string, source: string): Promise<SpellCheckIssue[]> {
  if (!supportsChktexChecks(path)) return [];
  const lints = await requestChktexLints(projectId, path, source, ++chktexSequence);
  return mapChktexLints(source, lints);
}
