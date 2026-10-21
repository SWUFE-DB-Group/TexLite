import { cleanupEfficiency, cleanupSemantic, type Diff } from "@sanity/diff-match-patch";

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
