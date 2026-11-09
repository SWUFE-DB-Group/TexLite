/** Counts for text that TeXcount cannot interpret, computed in the browser. */
export interface PlainTextCount {
  words: number;
  characters: number;
}

/** Prose files TeXcount cannot interpret, so the browser counts them instead. */
export function usesPlainTextCount(filePath: string): boolean {
  return /\.(?:md|txt)$/i.test(filePath);
}

const CJK = "\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}";
const WORD_TOKEN = new RegExp(`[${CJK}]|[^\\s${CJK}]+`, "gu");
const COUNTABLE = /[\p{L}\p{N}]/u;
const CHARACTER = /[\p{L}\p{N}]/gu;

/**
 * Whitespace separates words, as in a word processor, so a URL or `**bold**`
 * is one word and a bare `#` or `-` is none. CJK text has no spaces, so each
 * character counts as one word.
 */
export function countPlainText(text: string): PlainTextCount {
  let words = 0;
  for (const [token] of text.matchAll(WORD_TOKEN)) {
    if (COUNTABLE.test(token)) words += 1;
  }
  return { words, characters: text.match(CHARACTER)?.length ?? 0 };
}
