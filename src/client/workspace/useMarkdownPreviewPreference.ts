import { useEffect, useState } from "react";
import { scopedStorageKey } from "../basePath";
import { readStorage, writeStorage } from "../browserStorage";

function storageKey(userId: string, projectId: string): string {
  return scopedStorageKey(`texlite.markdownPreview:${encodeURIComponent(userId)}:${encodeURIComponent(projectId)}`);
}

/**
 * Whether opening a Markdown file shows its rendered preview instead of the
 * PDF. On by default; choosing the PDF tab while a Markdown file is open turns
 * it off for this project in this browser.
 */
export function useMarkdownPreviewPreference(userId: string, projectId: string) {
  const load = () => readStorage(storageKey(userId, projectId)) !== "pdf";
  const [preferred, setPreferredState] = useState(load);
  useEffect(() => setPreferredState(load()), [userId, projectId]);
  const setPreferred = (next: boolean) => {
    setPreferredState(next);
    writeStorage(storageKey(userId, projectId), next ? "markdown" : "pdf");
  };
  return [preferred, setPreferred] as const;
}
