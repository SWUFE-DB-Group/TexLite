/** Private library collections organize references without duplicating them. */
export interface CitationCollection {
  id: string;
  name: string;
  entryCount: number;
}

export interface CitationCollectionCatalog {
  collections: CitationCollection[];
  total: number;
  unfiled: number;
}

export const citationCollectionMessages = {
  en: {
    CITATION_NOTES_TOO_LARGE: "Notes must be 64 KB or smaller.",
    CITATION_FOLDER_INVALID: "Choose a valid TexLite citation folder exported with notes.",
    CITATION_FOLDER_TOO_LARGE: "Folder transfers support up to 16 MB and 500 entries.",
    CITATION_COLLECTION_NOT_FOUND: "The citation folder does not exist.",
    CITATION_COLLECTION_FULL: "This folder has reached its 500-entry limit. Remove a reference before adding another.",
    CITATION_COLLECTION_NAME_EXISTS: "A citation folder with this name already exists.",
    CITATION_COLLECTION_NAME_INVALID: "Use a folder name of 80 characters or fewer."
  },
  zh: {
    CITATION_NOTES_TOO_LARGE: "笔记不能超过 64 KB。",
    CITATION_FOLDER_INVALID: "请选择通过 TexLite 导出的含笔记文献文件夹。",
    CITATION_FOLDER_TOO_LARGE: "文献文件夹传输最多支持 16 MB 和 500 个条目。",
    CITATION_COLLECTION_NOT_FOUND: "此文献文件夹不存在。",
    CITATION_COLLECTION_FULL: "此文件夹已达到 500 条文献上限，请先移出部分文献再添加。",
    CITATION_COLLECTION_NAME_EXISTS: "已存在同名的文献文件夹。",
    CITATION_COLLECTION_NAME_INVALID: "请输入不超过 80 个字符的文件夹名称。"
  },
  "zh-Hant": {
    CITATION_NOTES_TOO_LARGE: "筆記不能超過 64 KB。",
    CITATION_FOLDER_INVALID: "請選擇透過 TexLite 匯出的含筆記文獻資料夾。",
    CITATION_FOLDER_TOO_LARGE: "文獻資料夾傳輸最多支援 16 MB 和 500 個條目。",
    CITATION_COLLECTION_NOT_FOUND: "此文獻資料夾不存在。",
    CITATION_COLLECTION_FULL: "此資料夾已達 500 條文獻上限，請先移出部分文獻再新增。",
    CITATION_COLLECTION_NAME_EXISTS: "已存在同名的文獻資料夾。",
    CITATION_COLLECTION_NAME_INVALID: "請輸入不超過 80 個字元的資料夾名稱。"
  }
} as const;
