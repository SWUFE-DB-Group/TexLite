import { makeDiff, type Diff } from "@sanity/diff-match-patch";

const words = new Intl.Segmenter(undefined, { granularity: "word" });
const SURROGATE_START = 0xd800;
const SURROGATE_COUNT = 0x800;
const MAX_TOKEN_ID = 0xffff - SURROGATE_COUNT;

/** Preview-only word diff. It never supplies offsets or patches to acceptance. */
export function makeSuggestionDiff(original: string, replacement: string): Diff[] {
  if (original === replacement) return original ? [[0, original]] : [];
  const vocabulary = [""];
  const ids = new Map<string, string>();
  const encode = (source: string): string | null => {
    const encoded: string[] = [];
    for (const { segment } of words.segment(source)) {
      let token = ids.get(segment);
      if (token === undefined) {
        const id = vocabulary.length;
        if (id > MAX_TOKEN_ID) return null;
        token = String.fromCharCode(id < SURROGATE_START ? id : id + SURROGATE_COUNT);
        vocabulary.push(segment); ids.set(segment, token);
      }
      encoded.push(token);
    }
    return encoded.join("");
  };
  const before = encode(original), after = encode(replacement);
  // Unusually large vocabularies still get a lossless before/after preview.
  if (before === null || after === null) return [[-1, original], [1, replacement]].filter(([, text]) => text !== "") as Diff[];
  return makeDiff(before, after, { checkLines: false, timeout: 1 }).map(([kind, tokens]) => [kind, Array.from(tokens, (token) => {
    const code = token.charCodeAt(0);
    return vocabulary[code < SURROGATE_START ? code : code - SURROGATE_COUNT]!;
  }).join("")]);
}
