import { makeDiff, type Diff } from "@sanity/diff-match-patch";

const SURROGATE_START = 0xd800;
const SURROGATE_COUNT = 0x800;
const MAX_LINE_ID = 0xffff - SURROGATE_COUNT;
const OLD_TEXT_LINE_LIMIT = 40_000;

/**
 * Keep project snapshots line-oriented: checkLines is only an optimization
 * in makeDiff and can refine changes down to individual characters.
 * Encode whole lines as BMP tokens, skipping surrogate code units so the
 * library's Unicode repair cannot treat two line ids as one character.
 */
export function makeLineDiff(before: string, after: string): Diff[] {
  if (before === after) return before ? [[0, before]] : [];
  const lines = [""];
  const tokens = new Map<string, string>();

  const encode = (source: string, limit: number): string => {
    const result: string[] = [];
    for (let start = 0; start < source.length;) {
      const newline = source.indexOf("\n", start);
      let end = newline < 0 ? source.length : newline + 1;
      let line = source.slice(start, end);
      let token = tokens.get(line);
      if (token === undefined) {
        // Reserve the last available id for the remaining tail. This keeps
        // large inputs lossless without wrapping token ids or throwing.
        if (lines.length === limit) {
          line = source.slice(start);
          end = source.length;
          token = tokens.get(line);
        }
        if (token === undefined) {
          const id = lines.length;
          token = String.fromCharCode(id < SURROGATE_START ? id : id + SURROGATE_COUNT);
          lines.push(line);
          tokens.set(line, token);
        }
      }
      result.push(token);
      start = end;
    }
    return result.join("");
  };

  const oldTokens = encode(before, OLD_TEXT_LINE_LIMIT);
  const newTokens = encode(after, MAX_LINE_ID);
  return makeDiff(oldTokens, newTokens, { checkLines: false, timeout: 1 }).map<Diff>(([operation, encoded]) => {
    const decoded = Array.from(encoded, (token) => {
      const code = token.charCodeAt(0);
      const id = code < SURROGATE_START ? code : code - SURROGATE_COUNT;
      return lines[id]!;
    });
    return [operation, decoded.join("")];
  });
}
