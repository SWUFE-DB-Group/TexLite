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
    CITATION_COLLECTION_NOT_FOUND: "The citation folder does not exist.",
    CITATION_COLLECTION_NAME_EXISTS: "A citation folder with this name already exists.",
    CITATION_COLLECTION_NAME_INVALID: "Use a folder name of 80 characters or fewer."
  },
  zh: {
    CITATION_COLLECTION_NOT_FOUND: "此文献文件夹不存在。",
    CITATION_COLLECTION_NAME_EXISTS: "已存在同名的文献文件夹。",
    CITATION_COLLECTION_NAME_INVALID: "请输入不超过 80 个字符的文件夹名称。"
  },
  "zh-Hant": {
    CITATION_COLLECTION_NOT_FOUND: "此文獻資料夾不存在。",
    CITATION_COLLECTION_NAME_EXISTS: "已存在同名的文獻資料夾。",
    CITATION_COLLECTION_NAME_INVALID: "請輸入不超過 80 個字元的資料夾名稱。"
  }
} as const;
