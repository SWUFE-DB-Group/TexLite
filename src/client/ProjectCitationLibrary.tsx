import { useEffect, useMemo, useRef, useState } from "react";
import { BookMarked, ChevronLeft, ChevronRight, FileText, FolderOpen, LoaderCircle, Search } from "lucide-react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { api } from "./api";
import { Modal } from "./Dialog";
import { CitationCard } from "./CitationCard";
import { CitationCollections } from "./CitationCollections";
import { CitationTagFilters } from "./CitationTagFilters";
import { errorMessage } from "./errors";
import { citationBibtexLimitLabel, parseBibEntriesResult, type ParsedCitationEntry } from "./citationLibrary";
import { bibtexDisplayText } from "../shared/bibtexText";
import type { CitationCollectionCatalog } from "../shared/citationCollections";
import type { CitationLibraryEntry, CitationLibraryTag, ProjectListPagination } from "./types";

const noop = () => undefined;
const PAGE_SIZE = 60;

const emptyPagination: ProjectListPagination = { page: 1, pageSize: PAGE_SIZE, total: 0, totalPages: 0 };

type CurrentFilter = "all" | "new";
const statusFilterLabels = {
  all: "citationProject.statusAll", new: "citationProject.statusNew"
} as const satisfies Record<CurrentFilter, string>;

/** Lower-cased text with accents removed, so "godel" finds "G{\"o}del". */
function searchable(value: string): string {
  return value.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

/** What a current-file search matches: the key and the fields a card shows, as written and as displayed. */
function currentEntrySearchText(entry: ParsedCitationEntry): string {
  const fields = [entry.title, entry.authors, entry.venue].filter((value): value is string => Boolean(value));
  return searchable([entry.citationKey, entry.year ?? "", ...fields, ...fields.map(bibtexDisplayText)].join("\n"));
}

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
  const isBib = /\.bib$/i.test(currentFile);
  // A .bib file opens on its own entries; any other file has none to list.
  const defaultView = isBib ? "current" : "library";
  const [view, setView] = useState<"library" | "current">(defaultView);
  const [catalog, setCatalog] = useState<CitationCollectionCatalog>({ collections: [], total: 0, unfiled: 0 });
  /** Library filter (left sidebar, My library tab only). */
  const [collection, setCollection] = useState("");
  /** Folder that new entries from the current file are saved into. */
  const [destination, setDestination] = useState("");
  const [query, setQuery] = useState("");
  const [tags, setTags] = useState<CitationLibraryTag[]>([]);
  const [selectedTag, setSelectedTag] = useState("");
  const [page, setPage] = useState(1);
  const [entries, setEntries] = useState<CitationLibraryEntry[]>([]);
  const [pagination, setPagination] = useState(emptyPagination);
  const [loading, setLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);
  const [lookupNonce, setLookupNonce] = useState(0);
  /** Lower-cased keys of current-file entries already in the library, for the file as it was read. */
  const [comparison, setComparison] = useState<{ signature: string; inLibrary: Set<string> } | null>(null);
  const [comparing, setComparing] = useState(false);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [importingKey, setImportingKey] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [currentQuery, setCurrentQuery] = useState("");
  const [currentFilter, setCurrentFilter] = useState<CurrentFilter>("all");
  const [currentPage, setCurrentPage] = useState(1);
  const scope = useRef<AbortController | null>(null);
  const pending = useRef(false);
  const source = useRef(currentSource); source.current = currentSource;
  // The current file is read once each time the dialog opens (or shows
  // another file). Later edits by collaborators or agents are not re-parsed
  // or re-compared while it stays open; reopening shows them.
  const snapshotKey = open ? currentFile : null;
  const [snapshot, setSnapshot] = useState({ key: snapshotKey, source: currentSource });
  const parsedSource = snapshot.key === snapshotKey ? snapshot.source : currentSource;
  const parsed = useMemo(() => open && isBib ? parseBibEntriesResult(parsedSource, maxBibtexBytes) : { status: "empty", entries: [] } as const, [open, isBib, parsedSource, maxBibtexBytes]);
  const parsedRef = useRef(parsed); parsedRef.current = parsed;
  const signature = useMemo(() => parsed.entries.map((entry) => entry.citationKey.toLowerCase()).join("\u0000"), [parsed]);
  const signatureRef = useRef(signature); signatureRef.current = signature;
  const currentKeys = useMemo(() => new Set(parsed.entries.map((entry) => entry.citationKey.toLowerCase())), [parsed]);
  const filterFolder = catalog.collections.find((folder) => folder.id === collection);
  const destinationFolder = catalog.collections.find((folder) => folder.id === destination);
  const comparisonReady = comparison?.signature === signature && !comparing;
  const searchTexts = useMemo(() => parsed.entries.map(currentEntrySearchText), [parsed]);
  // A large .bib file is shown a page at a time. The library check still
  // covers every key in the file, so the filter and counts are exact.
  const inLibrary = useMemo(() => comparisonReady
    ? parsed.entries.map((entry) => comparison.inLibrary.has(entry.citationKey.toLowerCase()))
    : null, [comparisonReady, comparison, parsed]);
  const statusCounts = useMemo(() => ({
    all: parsed.entries.length, new: inLibrary ? inLibrary.filter((saved) => !saved).length : 0
  }), [inLibrary, parsed]);
  const currentMatches = useMemo(() => {
    const terms = searchable(currentQuery).split(/\s+/).filter(Boolean);
    const onlyNew = inLibrary !== null && currentFilter === "new";
    return parsed.entries.map((entry, index) => ({ entry, index })).filter(({ index }) =>
      (!onlyNew || !inLibrary[index]) && terms.every((term) => searchTexts[index].includes(term)));
  }, [parsed, searchTexts, inLibrary, currentFilter, currentQuery]);
  const currentTotalPages = Math.ceil(currentMatches.length / PAGE_SIZE);
  // Editing the file can shrink the list below the selected page.
  const shownCurrentPage = Math.min(currentPage, Math.max(1, currentTotalPages));
  const currentPagination: ProjectListPagination = { page: shownCurrentPage, pageSize: PAGE_SIZE, total: currentMatches.length, totalPages: currentTotalPages };
  const currentPageEntries = currentMatches.slice((shownCurrentPage - 1) * PAGE_SIZE, shownCurrentPage * PAGE_SIZE);

  useEffect(() => {
    if (snapshot.key !== snapshotKey) setSnapshot({ key: snapshotKey, source: source.current });
  }, [snapshot.key, snapshotKey]);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController(); scope.current = controller; pending.current = false;
    setView(defaultView); setDestination(""); setCurrentQuery(""); setCurrentFilter("all"); setCurrentPage(1); setQuery(""); setSelectedTag(""); setPage(1); setComparison(null); setError(""); setSavingKey(null); setImportingKey(null);
    return () => { controller.abort(); if (scope.current === controller) scope.current = null; };
  }, [open, currentFile, currentUserId]);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    void api<CitationCollectionCatalog>("/api/citations/collections", { signal: controller.signal }).then((result) => {
      if (controller.signal.aborted) return;
      setCatalog(result);
      setCollection((id) => !id || id === "unfiled" || result.collections.some((folder) => folder.id === id) ? id : "");
      setDestination((id) => result.collections.some((folder) => folder.id === id) ? id : "");
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
      const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
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
      const { status, entries: fileEntries } = parsedRef.current;
      if (status === "invalid" || status === "too-large" || !fileEntries.length) { setComparison(null); setComparing(false); return; }
      void api<{ matches: Array<{ citationKey: string }> }>("/api/citations/lookup", {
        method: "POST", body: JSON.stringify({ keys: fileEntries.map((entry) => entry.citationKey) }), signal: controller.signal
      }).then((result) => {
        if (!controller.signal.aborted) setComparison({ signature, inLibrary: new Set(result.matches.map((match) => match.citationKey.toLowerCase())) });
      }).catch((reason) => { if (!controller.signal.aborted) { setComparison(null); setError(errorMessage(reason)); } })
        .finally(() => { if (!controller.signal.aborted) setComparing(false); });
    }, 180);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [open, view, signature, currentUserId, currentFile, lookupNonce]);

  /** Save a current-file entry that is not in the library yet. Library entries are never changed from here. */
  const save = async (entry: ParsedCitationEntry) => {
    const controller = scope.current;
    const key = entry.citationKey.toLowerCase();
    if (!controller || controller.signal.aborted || pending.current || !comparisonReady || comparison.inLibrary.has(key) || !destinationFolder) return;
    const savedSignature = signature;
    pending.current = true; setSavingKey(entry.citationKey); setError("");
    try {
      await api<{ entry: CitationLibraryEntry }>("/api/citations", { method: "POST", signal: controller.signal,
        body: JSON.stringify({ ...entry, collectionIds: [destinationFolder.id] }) });
      if (controller.signal.aborted) return;
      // The card turns into "Saved" for as long as this file is shown.
      if (signatureRef.current === savedSignature) {
        setComparison((current) => current?.signature === savedSignature
          ? { signature: savedSignature, inLibrary: new Set(current.inLibrary).add(key) }
          : current);
      }
      setRefresh((value) => value + 1);
    } catch (reason) {
      // A key saved elsewhere meanwhile is rejected by the server; re-check.
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

  // The sidebar filters the library, so it only belongs to that tab. Entering
  // the current file with no destination yet offers the folder being browsed.
  const showCurrent = () => {
    setView("current"); setError("");
    if (!destination && filterFolder) setDestination(filterFolder.id);
  };

  return <Modal open={open} extraWide className="citation-library-modal citation-project-modal management-dialog" title={t("citationLibrary.title")} description={currentFile}
    onOpenChange={onOpenChange} footer={<button onClick={() => onOpenChange(false)}>{t("common.close")}</button>}>
    <div className={`citation-library-layout${view === "current" ? " without-sidebar" : ""}`}>
      {view === "library" && <CitationCollections catalog={catalog} selected={collection} onSelect={(id) => { setCollection(id); setPage(1); }} onChanged={noop} onDeleted={noop} manage={false} />}
      <div className="citation-library-dialog">
        <div className="citation-library-tabs" role="tablist" aria-label={t("citationLibrary.title")}>
          <button type="button" role="tab" aria-selected={view === "current"} className={view === "current" ? "active" : ""} onClick={showCurrent}><FileText size={15} />{t("citationLibrary.currentFile")}<span>{parsed.entries.length}</span></button>
          <button type="button" role="tab" aria-selected={view === "library"} className={view === "library" ? "active" : ""} onClick={() => { setView("library"); setError(""); }}><BookMarked size={15} />{t("citationLibrary.myLibrary")}</button>
        </div>
        <p className="citation-project-intro">{t(view === "current" ? "citationProject.introCurrent"
          : !isBib ? "citationProject.introLibraryNeedsBib" : readOnly ? "citationLibrary.importRequiresWrite" : "citationProject.introLibrary")}</p>
        {error && <p className="error dialog-error" role="alert">{error}</p>}
        {view === "library" ? <>
          <div className="citation-library-scope-heading"><strong><FolderOpen size={15} />{filterFolder?.name ?? t(collection === "unfiled" ? "citationFolders.unfiled" : "citationFolders.all")}</strong></div>
          <label className="citation-library-search"><Search size={15} /><input aria-label={t("citationLibrary.searchPlaceholder")} placeholder={t("citationLibrary.searchPlaceholder")} value={query} onChange={(event) => { setQuery(event.target.value); setPage(1); }} /></label>
          <CitationTagFilters tags={tags} selectedId={selectedTag} onSelect={(id) => { setSelectedTag(id); setPage(1); }} />
          {loading ? <div className="citation-library-empty"><LoaderCircle className="spin" size={22} />{t("common.loading")}</div> : !entries.length ? <div className="citation-library-empty"><BookMarked size={28} /><strong>{t("citationLibrary.emptyTitle")}</strong><span>{t("citationFolders.empty")}</span></div>
            : <div className="citation-entry-list">{entries.map((entry) => <CitationCard key={entry.id} entry={entry} manage={false} alreadyInFile={currentKeys.has(entry.citationKey.toLowerCase())}
              importDisabled={readOnly || !isBib || Boolean(savingKey || importingKey)} importHint={readOnly ? t("citationLibrary.importRequiresWrite") : undefined} onImport={() => insert(entry)} t={t} />)}</div>}
          <CitationPagination pagination={{ ...pagination, page }} onPage={setPage} t={t} />
        </> : <>
          <label className="citation-project-destination"><FolderOpen size={15} /><span>{t("citationProject.saveFolder")}</span><select aria-label={t("citationProject.saveFolder")} value={destinationFolder?.id ?? ""} disabled={Boolean(savingKey)} onChange={(event) => setDestination(event.target.value)}>
            <option value="">{t("citationProject.chooseFolder")}</option>{catalog.collections.map((folder) => <option value={folder.id} key={folder.id}>{folder.name}</option>)}
          </select></label>
          {!catalog.collections.length && <p className="field-hint">{t("citationFolders.none")}</p>}
          {parsed.status === "too-large" && <p className="warning">{t("citationLibrary.fileTooLarge", { size: citationBibtexLimitLabel(maxBibtexBytes) })}</p>}
          {parsed.status === "invalid" && <p className="warning">{t("citationLibrary.fileInvalid")}</p>}
          {parsed.entries.length > 0 && <>
            <label className="citation-library-search"><Search size={15} /><input aria-label={t("citationProject.searchPlaceholder")} placeholder={t("citationProject.searchPlaceholder")} value={currentQuery} onChange={(event) => { setCurrentQuery(event.target.value); setCurrentPage(1); }} /></label>
            <div className="citation-tag-filters citation-status-filters" role="group" aria-label={t("citationProject.statusFilters")}>
              {(["all", "new"] as const).map((filter) => {
                const active = (inLibrary ? currentFilter : "all") === filter;
                return <button type="button" key={filter} className={active ? "active" : ""} aria-pressed={active} disabled={!inLibrary && filter !== "all"}
                  onClick={() => { setCurrentFilter(filter); setCurrentPage(1); }}>{t(statusFilterLabels[filter])}{(inLibrary || filter === "all") && <span>{statusCounts[filter]}</span>}</button>;
              })}
            </div>
          </>}
          {!parsed.entries.length ? <div className="citation-library-empty"><FileText size={28} /><strong>{t("citationLibrary.noEntries")}</strong></div>
            : !currentMatches.length ? <div className="citation-library-empty"><Search size={28} /><strong>{t("citationProject.noMatches")}</strong></div>
            : <div className="citation-entry-list">{currentPageEntries.map(({ entry, index }) => {
            const saved = Boolean(inLibrary?.[index]);
            const hint = !comparisonReady ? t(comparing ? "common.loading" : "citationProject.comparisonUnavailable") : !destinationFolder ? t("citationProject.chooseFolder") : undefined;
            // An entry already in the library shows "Saved" and has no action here.
            return <CitationCard key={`${entry.citationKey}-${index}`} entry={entry} manage={false} saved={saved} saving={savingKey === entry.citationKey}
              saveDisabled={!comparisonReady || Boolean(savingKey || importingKey) || !destinationFolder} saveHint={hint}
              onSave={saved ? undefined : () => void save(entry)} t={t} />;
          })}</div>}
          <CitationPagination pagination={currentPagination} onPage={setCurrentPage} t={t} />
        </>}
      </div>
    </div>
  </Modal>;
}

function CitationPagination({ pagination, onPage, t }: {
  pagination: ProjectListPagination;
  onPage: (page: number) => void;
  t: TFunction;
}) {
  if (pagination.totalPages <= 1) return null;
  const label = t("citationLibraryPagination.pageOf", { ...pagination, count: pagination.total });
  return <nav className="citation-library-pagination" aria-label={label}>
    <button type="button" disabled={pagination.page <= 1} onClick={() => onPage(pagination.page - 1)}><ChevronLeft size={14} />{t("citationLibraryPagination.previous")}</button>
    <span>{label}</span>
    <button type="button" disabled={pagination.page >= pagination.totalPages} onClick={() => onPage(pagination.page + 1)}>{t("citationLibraryPagination.next")}<ChevronRight size={14} /></button>
  </nav>;
}
