import { cleanupEfficiency, cleanupSemantic, DIFF_DELETE, DIFF_EQUAL, makeDiff, type Diff } from "@sanity/diff-match-patch";

// With /u, a valid surrogate pair is one code point outside this range.
const UNPAIRED_SURROGATE = /[\uD800-\uDFFF]/u;

/**
 * makeDiff protects surrogate pairs, but cleanup can split them again while
 * shifting boundaries or merging edits. Keep the original diff in that case,
 * so rendered pieces and editor/anchor offsets stay on complete characters.
 */
export function cleanupTextDiff(diffs: Diff[], mode: "semantic" | "efficiency"): Diff[] {
  const cleaned = mode === "semantic" ? cleanupSemantic(diffs) : cleanupEfficiency(diffs, 4);
  return cleaned.some(([, text]) => UNPAIRED_SURROGATE.test(text)) ? diffs : cleaned;
}

/** Replace `before.slice(from, to)` with `insert`; offsets refer to `before`. */
export interface TextReplacement {
  from: number;
  to: number;
  insert: string;
}

/**
 * The non-overlapping replacements, in source order, that turn `before` into
 * `after`. Shared by the formatter (which applies them as editor edits) and the
 * coding-agent sync (which merges and records them). An optional cleanup pass
 * trades exact minimal edits for fewer, more readable ones.
 */
export function textReplacements(before: string, after: string, cleanup?: "semantic" | "efficiency"): TextReplacement[] {
  if (before === after) return [];
  const raw = makeDiff(before, after, { checkLines: true, timeout: 1 });
  const diffs = cleanup ? cleanupTextDiff(raw, cleanup) : raw;
  const replacements: TextReplacement[] = [];
  let offset = 0;
  let pending: TextReplacement | null = null;
  for (const [kind, text] of diffs) {
    if (kind === DIFF_EQUAL) {
      if (pending) replacements.push(pending);
      pending = null;
      offset += text.length;
      continue;
    }
    pending ??= { from: offset, to: offset, insert: "" };
    if (kind === DIFF_DELETE) {
      offset += text.length;
      pending.to = offset;
    } else {
      pending.insert += text;
    }
  }
  if (pending) replacements.push(pending);
  return replacements;
}
