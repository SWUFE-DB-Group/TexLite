import { useEffect, useMemo, useRef, useState } from "react";
import { BookMarked, ChevronLeft, ChevronRight, FileText, FolderOpen, LoaderCircle, Search } from "lucide-react";
import { useTranslation } from "react-i18next";
import { api } from "./api";
import { Modal } from "./Dialog";
import { CitationCard } from "./CitationCard";
import { CitationCollections } from "./CitationCollections";
import { CitationTagFilters } from "./CitationTagFilters";
import { errorMessage } from "./errors";
import { useSuccessNotice } from "./SuccessNotice";
import { citationBibtexLimitLabel, parseBibEntriesResult, type ParsedCitationEntry } from "./citationLibrary";
import { comparableCitationBibtex, type CitationContentMatch } from "../shared/citationContent";
import type { CitationCollectionCatalog } from "../shared/citationCollections";
import type { CitationLibraryEntry, CitationLibraryTag, ProjectListPagination } from "./types";

const noop = () => undefined;
const emptyPagination: ProjectListPagination = { page: 1, pageSize: 60, total: 0, totalPages: 0 };

/** Project import/save workflows do not mount private-library management UI. */
export function ProjectCitationLibrary({ open, onOpenChange, currentFile, currentSource, readOnly, currentUserId, maxBibtexBytes, onInsert }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentFile: string;
  currentSource: string;
  readOnly: boolean;
  currentUserId: string;
  maxBibtexBytes: number;
  onInsert: (entry: CitationLibraryEntry) => boolean | Promise<boolean>;
}) {
  const { t } = useTranslation();
  const [view, setView] = useState<"library" | "current">("library");
  const [catalog, setCatalog] = useState<CitationCollectionCatalog>({ collections: [], total: 0, unfiled: 0 });
  const [collection, setCollection] = useState("");
  const [query, setQuery] = useState("");
  const [tags, setTags] = useState<CitationLibraryTag[]>([]);
  const [selectedTag, setSelectedTag] = useState("");
  const [page, setPage] = useState(1);
  const [entries, setEntries] = useState<CitationLibraryEntry[]>([]);
  const [pagination, setPagination] = useState(emptyPagination);
  const [loading, setLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);
  const [lookupNonce, setLookupNonce] = useState(0);
  const [comparison, setComparison] = useState<{ source: string; matches: Map<string, CitationContentMatch> } | null>(null);
  const [comparing, setComparing] = useState(false);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [importingKey, setImportingKey] = useState<string | null>(null);
  const [error, setError] = useState("");
  const scope = useRef<AbortController | null>(null);
  const pending = useRef(false);
  const source = useRef(currentSource); source.current = currentSource;
  const feedback = useSuccessNotice();
  const isBib = /\.bib$/i.test(currentFile);
  const parsed = useMemo(() => open && isBib ? parseBibEntriesResult(currentSource, maxBibtexBytes) : { status: "empty", entries: [] } as const, [open, isBib, currentSource, maxBibtexBytes]);
  const currentKeys = useMemo(() => new Set(parsed.entries.map((entry) => entry.citationKey.toLowerCase())), [parsed]);
  const selectedFolder = catalog.collections.find((folder) => folder.id === collection);
  const comparisonReady = comparison?.source === currentSource && !comparing;

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController(); scope.current = controller; pending.current = false;
    setView("library"); setQuery(""); setSelectedTag(""); setPage(1); setComparison(null); setError(""); setSavingKey(null); setImportingKey(null); feedback.clear();
    return () => { controller.abort(); if (scope.current === controller) scope.current = null; };
  }, [open, currentFile, currentUserId]);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    void api<CitationCollectionCatalog>("/api/citations/collections", { signal: controller.signal }).then((result) => {
      if (controller.signal.aborted) return;
      setCatalog(result);
      setCollection((id) => !id || id === "unfiled" || result.collections.some((folder) => folder.id === id) ? id : "");
    }).catch((reason) => { if (!controller.signal.aborted) setError(errorMessage(reason)); });
    return () => controller.abort();
  }, [open, currentUserId, refresh]);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    void api<{ tags: CitationLibraryTag[] }>("/api/citations/tags", { signal: controller.signal }).then((result) => {
      if (!controller.signal.aborted) setTags(result.tags);
    }).catch((reason) => { if (!controller.signal.aborted) setError(errorMessage(reason)); });
    return () => controller.abort();
  }, [open, currentUserId]);

  useEffect(() => {
    if (!open || view !== "library") return;
    const controller = new AbortController(); setLoading(true);
    const timer = setTimeout(() => {
      const params = new URLSearchParams({ page: String(page), pageSize: "60" });
      if (collection) params.set("collection", collection);
      if (selectedTag) params.set("tag", selectedTag);
      if (query.trim()) params.set("q", query.trim());
      void api<{ entries: CitationLibraryEntry[]; pagination: ProjectListPagination }>(`/api/citations?${params}`, { signal: controller.signal }).then((result) => {
        if (controller.signal.aborted) return;
        setEntries(result.entries); setPagination(result.pagination);
        if (result.pagination.page !== page) setPage(result.pagination.page);
      }).catch((reason) => { if (!controller.signal.aborted) setError(errorMessage(reason)); })
        .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    }, query.trim() ? 180 : 0);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [open, view, collection, selectedTag, query, page, refresh, currentFile, currentUserId]);

  useEffect(() => {
    if (!open || view !== "current") return;
    const controller = new AbortController(); setComparing(true);
    const timer = setTimeout(() => {
      if (parsed.status === "invalid" || parsed.status === "too-large" || !parsed.entries.length) { setComparison(null); setComparing(false); return; }
      void api<{ matches: CitationContentMatch[] }>("/api/citations/lookup", {
        method: "POST", body: JSON.stringify({ entries: parsed.entries.map(({ citationKey, bibtex }) => ({ citationKey, bibtex })) }), signal: controller.signal
      }).then((result) => {
        if (!controller.signal.aborted) setComparison({ source: currentSource, matches: new Map(result.matches.map((match) => [match.citationKey.toLowerCase(), match])) });
      }).catch((reason) => { if (!controller.signal.aborted) { setComparison(null); setError(errorMessage(reason)); } })
        .finally(() => { if (!controller.signal.aborted) setComparing(false); });
    }, 180);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [open, view, parsed, currentSource, currentUserId, currentFile, lookupNonce]);

  const save = async (entry: ParsedCitationEntry) => {
    const controller = scope.current;
    const existing = comparison?.matches.get(entry.citationKey.toLowerCase());
    if (!controller || controller.signal.aborted || pending.current || !comparisonReady || existing?.sameContent || (!existing && !selectedFolder)) return;
    const savedSource = currentSource;
    pending.current = true; setSavingKey(entry.citationKey); setError(""); feedback.clear();
    try {
      const result = await api<{ entry: CitationLibraryEntry }>("/api/citations", { method: "POST", signal: controller.signal,
        body: JSON.stringify({ ...entry, overwrite: Boolean(existing), expectedRevision: existing?.revision, collectionIds: existing ? undefined : [selectedFolder!.id] }) });
      if (controller.signal.aborted) return;
      if (source.current === savedSource) {
        setComparison((current) => {
          if (current?.source !== savedSource) return current;
          const matches = new Map(current.matches);
          matches.set(entry.citationKey.toLowerCase(), { id: result.entry.id, citationKey: result.entry.citationKey, revision: result.entry.revision,
            sameContent: comparableCitationBibtex(result.entry.bibtex) === comparableCitationBibtex(entry.bibtex) });
          return { source: savedSource, matches };
        });
        feedback.show(entry.citationKey);
      }
      setRefresh((value) => value + 1); setLookupNonce((value) => value + 1);
    } catch (reason) {
      if (!controller.signal.aborted) { setError(errorMessage(reason)); setLookupNonce((value) => value + 1); }
    } finally { if (scope.current === controller) { pending.current = false; setSavingKey(null); } }
  };

  const insert = async (entry: CitationLibraryEntry) => {
    const controller = scope.current;
    if (!controller || controller.signal.aborted || pending.current || readOnly || !isBib || currentKeys.has(entry.citationKey.toLowerCase())) return;
    pending.current = true; setImportingKey(entry.citationKey); setError("");
    try { if (await onInsert(entry) && !controller.signal.aborted) onOpenChange(false); }
    catch (reason) { if (!controller.signal.aborted) setError(errorMessage(reason)); }
    finally { if (scope.current === controller) { pending.current = false; setImportingKey(null); } }
  };

  return <Modal open={open} extraWide className="citation-library-modal citation-project-modal management-dialog" title={t("citationLibrary.title")} description={currentFile}
    onOpenChange={onOpenChange} footer={<button onClick={() => onOpenChange(false)}>{t("common.close")}</button>}>
    <div className="citation-library-layout">
      <CitationCollections catalog={catalog} selected={collection} onSelect={(id) => { setCollection(id); setPage(1); }} onChanged={noop} onDeleted={noop} manage={false} />
      <div className="citation-library-dialog">
        <div className="citation-library-tabs" role="tablist" aria-label={t("citationLibrary.title")}>
          <button type="button" role="tab" aria-selected={view === "library"} className={view === "library" ? "active" : ""} onClick={() => { setView("library"); setError(""); }}><BookMarked size={15} />{t("citationLibrary.myLibrary")}</button>
          <button type="button" role="tab" aria-selected={view === "current"} className={view === "current" ? "active" : ""} onClick={() => { setView("current"); setError(""); }}><FileText size={15} />{t("citationLibrary.currentFile")}<span>{parsed.entries.length}</span></button>
        </div>
        {error && <p className="error dialog-error" role="alert">{error}</p>}
        {view === "library" ? <>
          <div className="citation-library-scope-heading"><strong><FolderOpen size={15} />{selectedFolder?.name ?? t(collection === "unfiled" ? "citationFolders.unfiled" : "citationFolders.all")}</strong></div>
          <label className="citation-library-search"><Search size={15} /><input aria-label={t("citationLibrary.searchPlaceholder")} placeholder={t("citationLibrary.searchPlaceholder")} value={query} onChange={(event) => { setQuery(event.target.value); setPage(1); }} /></label>
          <CitationTagFilters tags={tags} selectedId={selectedTag} onSelect={(id) => { setSelectedTag(id); setPage(1); }} />
          {loading ? <div className="citation-library-empty"><LoaderCircle className="spin" size={22} />{t("common.loading")}</div> : !entries.length ? <div className="citation-library-empty"><BookMarked size={28} /><strong>{t("citationLibrary.emptyTitle")}</strong><span>{t("citationFolders.empty")}</span></div>
            : <div className="citation-entry-list">{entries.map((entry) => <CitationCard key={entry.id} entry={entry} manage={false} alreadyInFile={currentKeys.has(entry.citationKey.toLowerCase())}
              importDisabled={readOnly || !isBib || Boolean(savingKey || importingKey)} importHint={readOnly ? t("citationLibrary.importRequiresWrite") : undefined} onImport={() => insert(entry)} t={t} />)}</div>}
          {pagination.totalPages > 1 && <nav className="citation-library-pagination" aria-label={t("citationLibraryPagination.pageOf", { ...pagination, count: pagination.total })}>
            <button disabled={page <= 1} onClick={() => setPage((value) => value - 1)}><ChevronLeft size={14} />{t("citationLibraryPagination.previous")}</button>
            <span>{t("citationLibraryPagination.pageOf", { ...pagination, count: pagination.total })}</span>
            <button disabled={page >= pagination.totalPages} onClick={() => setPage((value) => value + 1)}>{t("citationLibraryPagination.next")}<ChevronRight size={14} /></button>
          </nav>}
        </> : <>
          <label className="citation-project-destination"><FolderOpen size={15} /><span>{t("citationProject.saveFolder")}</span><select aria-label={t("citationProject.saveFolder")} value={selectedFolder?.id ?? ""} disabled={Boolean(savingKey)} onChange={(event) => setCollection(event.target.value)}>
            <option value="">{t("citationProject.chooseFolder")}</option>{catalog.collections.map((folder) => <option value={folder.id} key={folder.id}>{folder.name}</option>)}
          </select></label>
          {!catalog.collections.length && <p className="field-hint">{t("citationFolders.none")}</p>}
          {parsed.status === "too-large" && <p className="warning">{t("citationLibrary.fileTooLarge", { size: citationBibtexLimitLabel(maxBibtexBytes) })}</p>}
          {parsed.status === "invalid" && <p className="warning">{t("citationLibrary.fileInvalid")}</p>}
          {!parsed.entries.length ? <div className="citation-library-empty"><FileText size={28} /><strong>{t("citationLibrary.noEntries")}</strong></div> : <div className="citation-entry-list">{parsed.entries.map((entry, index) => {
            const match = comparison?.source === currentSource ? comparison.matches.get(entry.citationKey.toLowerCase()) : undefined;
            const hint = !comparisonReady ? t(comparing ? "common.loading" : "citationProject.comparisonUnavailable") : match?.sameContent ? t("citationProject.unchanged") : !match && !selectedFolder ? t("citationProject.chooseFolder") : undefined;
            return <CitationCard key={`${entry.citationKey}-${index}`} entry={entry} manage={false} saved={Boolean(match)} saving={savingKey === entry.citationKey}
              saveDisabled={!comparisonReady || Boolean(savingKey || importingKey) || Boolean(match?.sameContent) || (!match && !selectedFolder)} saveHint={hint}
              saveFeedback={feedback.message === entry.citationKey && match?.sameContent ? t("editor.saved") : ""} onSave={() => void save(entry)} t={t} />;
          })}</div>}
        </>}
      </div>
    </div>
  </Modal>;
}
