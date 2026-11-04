import type { EditorState } from "@codemirror/state";
import type { SearchQuery } from "@codemirror/search";

export function countSearchMatches(state: EditorState, query: SearchQuery): number {
  if (!query.valid || !query.search) return 0;
  let count = 0;
  const cursor = query.getCursor(state);
  while (!cursor.next().done) count += 1;
  return count;
}

export function currentSearchMatch(state: EditorState, query: SearchQuery): number {
  if (!query.valid || !query.search) return 0;
  const { from, to } = state.selection.main;
  const cursor = query.getCursor(state);
  let index = 0;
  for (let next = cursor.next(); !next.done; next = cursor.next()) {
    index += 1;
    if (next.value.from > from) break;
    if (next.value.from === from && next.value.to === to) return index;
  }
  return 0;
}

export function searchQuerySignature(query: SearchQuery): string {
  return JSON.stringify([
    query.search, query.caseSensitive, query.literal, query.regexp, query.wholeWord
  ]);
}
