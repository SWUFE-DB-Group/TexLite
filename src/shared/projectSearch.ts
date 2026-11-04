export const PROJECT_SEARCH_MAX_QUERY_LENGTH = 256;
export const PROJECT_SEARCH_MAX_MATCHES = 500;
export const PROJECT_SEARCH_MAX_REPLACEMENT_LENGTH = 10_000;

export interface ProjectSearchOptions {
  query: string;
  caseSensitive: boolean;
  wholeWord: boolean;
}

/** Zero-based UTF-16 offsets, matching CodeMirror and Y.Text coordinates. */
export interface ProjectSearchRange { from: number; to: number }

export interface ProjectSearchMatch extends ProjectSearchRange {
  path: string;
  line: number;
  column: number;
  preview: string;
  matchStart: number;
  matchEnd: number;
  sourceHash: string;
}

export interface ProjectSearchResult {
  matches: ProjectSearchMatch[];
  limited: boolean;
}

export interface ProjectReplaceTarget {
  path: string;
  sourceHash: string;
  ranges: ProjectSearchRange[];
}

export interface ProjectReplaceResult { replaced: number; files: number }

export const projectSearchMessages = {
  en: {
    SEARCH_SOURCE_CHANGED: "Source files changed since this search. Refresh results before replacing.",
    SEARCH_LIMITED: "Narrow your search before replacing: there are too many matches."
  },
  zh: {
    SEARCH_SOURCE_CHANGED: "搜索后源码已变化，请刷新结果后再替换。",
    SEARCH_LIMITED: "匹配过多，请缩小搜索范围后再替换。"
  },
  "zh-Hant": {
    SEARCH_SOURCE_CHANGED: "搜尋後原始碼已變更，請重新整理結果後再取代。",
    SEARCH_LIMITED: "相符結果過多，請縮小搜尋範圍後再取代。"
  }
};
