import { useEffect, useMemo, useState } from "react";
import { api } from "./api";
import { errorMessage } from "./errors";
import type { CitationLibraryEntry, ProjectListPagination } from "./types";

export const CITATION_PAGE_SIZE = 60;

type LibraryPage = { entries: CitationLibraryEntry[]; pagination: ProjectListPagination };
type LibraryResult = ({ status: "ready" } & LibraryPage) | { status: "error"; message: string };

/** Both library views expose only the entries and pagination for the current request. */
export function useCitationLibraryPage({
  enabled, userId, currentFile, collection, tag, query, page, refresh, onPage
}: {
  enabled: boolean;
  userId: string;
  currentFile?: string;
  collection: string;
  tag: string;
  query: string;
  page: number;
  refresh: number;
  onPage: (page: number) => void;
}) {
  const [retryVersion, setRetryVersion] = useState(0);
  const search = query.trim();
  const request = useMemo(() => {
    if (!enabled) return null;
    const params = new URLSearchParams({ page: String(page), pageSize: String(CITATION_PAGE_SIZE) });
    if (collection) params.set("collection", collection);
    if (tag) params.set("tag", tag);
    if (search) params.set("q", search);
    return { url: `/api/citations?${params}`, page, delay: search ? 180 : 0 };
  }, [enabled, userId, currentFile, collection, tag, search, page, refresh, retryVersion]);
  const [settled, setSettled] = useState<{ request: NonNullable<typeof request>; result: LibraryResult } | null>(null);

  useEffect(() => {
    if (!request) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void api<LibraryPage>(request.url, { signal: controller.signal }).then((result) => {
        if (controller.signal.aborted) return;
        if (result.pagination.page !== request.page) {
          onPage(result.pagination.page);
          return;
        }
        setSettled({ request, result: { ...result, status: "ready" } });
      }).catch((error) => {
        if (!controller.signal.aborted) setSettled({ request, result: { status: "error", message: errorMessage(error) } });
      });
    }, request.delay);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [request, onPage]);

  return {
    result: settled?.request === request ? settled.result : null,
    retry: () => setRetryVersion((version) => version + 1)
  };
}
