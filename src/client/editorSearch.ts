import type { EditorState } from "@codemirror/state";
import type { SearchQuery } from "@codemirror/search";

export function countSearchMatches(state: EditorState, query: SearchQuery): number {
  if (!query.valid || !query.search) return 0;
  let count = 0;
  const cursor = query.getCursor(state);
  while (!cursor.next().done) count += 1;
  return count;
}

export function searchQuerySignature(query: SearchQuery): string {
  return JSON.stringify([
    query.search, query.caseSensitive, query.literal, query.regexp, query.wholeWord
  ]);
}
