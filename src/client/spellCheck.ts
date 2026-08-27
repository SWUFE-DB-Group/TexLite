import { api } from "./api";

export interface RawHarperLint {
  start: number;
  end: number;
  problem: string;
  kind: string;
  message: string;
  suggestions: string[];
}

export type SpellCheckIssueKind = "spelling" | "grammar";

export interface SpellCheckIssue {
  from: number;
  to: number;
  word: string;
  kind: SpellCheckIssueKind;
  message: string;
  suggestions: string[];
}

interface Span {
  from: number;
  to: number;
}

const maxSuggestions = 5;
const lintResultCache = new Map<string, { path: string; source: string; dictionary: string; issues: SpellCheckIssue[] }>();
const maxCachedLintResults = 12;

interface PendingLintRequest {
  projectId: string;
  path: string;
  source: string;
  customWords: string[];
  resolve: (issues: SpellCheckIssue[]) => void;
  reject: (error: unknown) => void;
}

let activeLintRequest = false;
let pendingLintRequest: PendingLintRequest | null = null;

export class HarperLintSupersededError extends Error {
  constructor() {
    super("A newer writing check replaced this request.");
    this.name = "HarperLintSupersededError";
  }
}

export function isHarperLintSupersededError(error: unknown): error is HarperLintSupersededError {
  return error instanceof HarperLintSupersededError;
}

function scalarOffsets(source: string): number[] {
  const offsets = [0];
  let offset = 0;
  for (const character of source) {
    offset += character.length;
    offsets.push(offset);
  }
  return offsets;
}

function dictionaryKey(words: string[]): string {
  return [...new Set(words.map((word) => word.trim()).filter(Boolean))].sort((left, right) => left.localeCompare(right)).join("\u0000");
}

async function requestHarperLints(projectId: string, path: string, source: string): Promise<RawHarperLint[]> {
  const result = await api<{ lints: RawHarperLint[] }>(`/api/projects/${projectId}/spellcheck`, {
    method: "POST",
    body: JSON.stringify({ path, source })
  });
  return result.lints;
}

function resolveLintSpan(source: string, lint: RawHarperLint, scalarOffsetsMap: number[]): Span | null {
  if (!lint.problem) return null;
  const direct = { from: lint.start, to: lint.end };
  const scalar = {
    from: scalarOffsetsMap[lint.start] ?? -1,
    to: scalarOffsetsMap[lint.end] ?? -1
  };
  const valid = (candidate: Span): boolean => candidate.from >= 0 && candidate.to > candidate.from && candidate.to <= source.length;
  const matches = (candidate: Span): boolean => valid(candidate) && source.slice(candidate.from, candidate.to) === lint.problem;

  // `harper-cli` reports Unicode scalar positions. The server-side mask keeps
  // that coordinate system intact even when it hides an astral character.
  if (matches(scalar)) return scalar;
  // Retain a narrow compatibility fallback for a CLI release that may report
  // UTF-16 offsets, but never accept an unverified range. A mismatch means
  // Harper linted masked LaTeX syntax rather than source prose.
  if (matches(direct)) return direct;
  return null;
}

function mapLint(source: string, lint: RawHarperLint, offsets: number[]): SpellCheckIssue | null {
  const resolved = resolveLintSpan(source, lint, offsets);
  if (!resolved) return null;
  const { from, to } = resolved;
  const word = source.slice(from, to);
  if (!word.trim() || !/[A-Za-z]/.test(word)) return null;
  // TexLite promises writing diagnostics, not whitespace/layout suggestions.
  if (lint.kind === "Formatting") return null;
  const kind = lint.kind === "Spelling" || lint.kind === "Typo" ? "spelling" : "grammar";
  const suggestions = lint.suggestions.filter((text, index, values) => index < maxSuggestions && values.indexOf(text) === index);
  return { from, to, word, kind, message: lint.message, suggestions };
}

function sourceCacheKey(path: string, source: string): string {
  let hash = 2166136261;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `${path}\u0000${source.length}:${hash >>> 0}`;
}

function cachedLintResult(path: string, source: string, dictionary: string): SpellCheckIssue[] | null {
  const key = sourceCacheKey(path, source);
  const cached = lintResultCache.get(key);
  if (!cached || cached.path !== path || cached.source !== source || cached.dictionary !== dictionary) return null;
  lintResultCache.delete(key);
  lintResultCache.set(key, cached);
  return cached.issues;
}

function cacheLintResult(path: string, source: string, dictionary: string, issues: SpellCheckIssue[]): void {
  const key = sourceCacheKey(path, source);
  lintResultCache.set(key, { path, source, dictionary, issues });
  while (lintResultCache.size > maxCachedLintResults) {
    const oldest = lintResultCache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    lintResultCache.delete(oldest);
  }
}

export async function mapLatexLints(source: string, customWords: string[], lints: RawHarperLint[], path = "main.tex"): Promise<SpellCheckIssue[]> {
  const dictionary = dictionaryKey(customWords);
  const cached = cachedLintResult(path, source, dictionary);
  if (cached) return cached;
  const offsets = scalarOffsets(source);
  const projectWords = new Set(customWords.map((word) => word.trim().toLocaleLowerCase("en-US")).filter(Boolean));
  const seen = new Set<string>();
  const issues = lints.map((lint) => mapLint(source, lint, offsets)).filter((issue): issue is SpellCheckIssue => Boolean(issue))
    .filter((issue) => issue.kind !== "spelling" || !projectWords.has(issue.word.trim().toLocaleLowerCase("en-US")))
    .filter((issue) => {
      const key = `${issue.from}:${issue.to}:${issue.kind}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((left, right) => left.from - right.from || left.to - right.to);
  cacheLintResult(path, source, dictionary, issues);
  return issues;
}

async function lintLatexNow(projectId: string, path: string, source: string, customWords: string[]): Promise<SpellCheckIssue[]> {
  const dictionary = dictionaryKey(customWords);
  const cached = cachedLintResult(path, source, dictionary);
  if (cached) return cached;
  const lints = await requestHarperLints(projectId, path, source);
  return mapLatexLints(source, customWords, lints, path);
}

async function runLatestLintRequest(): Promise<void> {
  if (activeLintRequest || !pendingLintRequest) return;
  const request = pendingLintRequest;
  pendingLintRequest = null;
  activeLintRequest = true;
  try {
    request.resolve(await lintLatexNow(request.projectId, request.path, request.source, request.customWords));
  } catch (error) {
    request.reject(error);
  } finally {
    activeLintRequest = false;
    void runLatestLintRequest();
  }
}

/** Run the latest Harper check, replacing obsolete checks still waiting in the global queue. */
export function lintLatex(projectId: string, path: string, source: string, customWords: string[] = []): Promise<SpellCheckIssue[]> {
  return new Promise((resolve, reject) => {
    pendingLintRequest?.reject(new HarperLintSupersededError());
    pendingLintRequest = { projectId, path, source, customWords: [...customWords], resolve, reject };
    void runLatestLintRequest();
  });
}
