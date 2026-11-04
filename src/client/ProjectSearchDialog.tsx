import { useEffect, useId, useMemo, useRef, useState } from "react";
import { CaseSensitive, Check, ChevronDown, FileSearch, FileText, LoaderCircle, Replace, ReplaceAll, Search, WholeWord } from "lucide-react";
import { useTranslation } from "react-i18next";
import { PROJECT_SEARCH_MAX_QUERY_LENGTH, PROJECT_SEARCH_MAX_REPLACEMENT_LENGTH, type ProjectReplaceResult, type ProjectReplaceTarget, type ProjectSearchMatch, type ProjectSearchResult } from "../shared/projectSearch";
import { api } from "./api";
import { ConfirmDialog, Modal } from "./Dialog";
import { errorMessage } from "./errors";

export function ProjectSearchDialog({ projectId, onClose, onNavigate, readOnly = false }: {
  projectId: string; onClose: () => void; onNavigate: (path: string, line: number, column: number) => void; readOnly?: boolean;
}) {
  const { t } = useTranslation();
  const input = useRef<HTMLInputElement>(null);
  const headingId = useId();
  const [query, setQuery] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(true);
  const [wholeWord, setWholeWord] = useState(true);
  const [replacement, setReplacement] = useState("");
  const [replacing, setReplacing] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [mutationError, setMutationError] = useState("");
  const [notice, setNotice] = useState<number | null>(null);
  const busy = useRef(false), generation = useRef(0);
  const immediateRefresh = useRef<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [state, setState] = useState<{ criteria: string; request: string; result?: ProjectSearchResult; error?: string } | null>(null);
  const criteriaKey = JSON.stringify([projectId, query, caseSensitive, wholeWord]);
  const requestKey = JSON.stringify([criteriaKey, retry]);
  // Refreshing the same search retains its DOM, scroll position and collapsed
  // groups. Changed criteria must never display results from a previous search.
  const current = state?.criteria === criteriaKey ? state : null;
  const result = current?.result;
  const error = current?.request === requestKey ? current.error : undefined;
  const loading = Boolean(query) && current?.request !== requestKey;
  const locked = replacing || confirm;
  useEffect(() => { generation.current++; return () => { generation.current++; }; }, [projectId]);
  useEffect(() => { const timer = window.setTimeout(() => input.current?.focus(), 0); return () => window.clearTimeout(timer); }, []);
  useEffect(() => {
    if (!query) return;
    const controller = new AbortController();
    const delay = immediateRefresh.current === criteriaKey ? 0 : 350;
    immediateRefresh.current = null;
    const timer = window.setTimeout(() => {
      void api<ProjectSearchResult>(`/api/projects/${projectId}/search`, {
        method: "POST", body: JSON.stringify({ query, caseSensitive, wholeWord }), signal: controller.signal
      }).then((value) => {
        if (!controller.signal.aborted) setState({ criteria: criteriaKey, request: requestKey, result: value });
      }).catch((reason) => {
        if (!controller.signal.aborted) setState((previous) => ({ criteria: criteriaKey, request: requestKey,
          result: previous?.criteria === criteriaKey ? previous.result : undefined, error: errorMessage(reason) }));
      });
    }, delay);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [projectId, query, caseSensitive, wholeWord, criteriaKey, requestKey]);
  const groups = useMemo(() => {
    const files = new Map<string, ProjectSearchMatch[]>();
    for (const match of result?.matches ?? []) {
      const matches = files.get(match.path) ?? []; matches.push(match); files.set(match.path, matches);
    }
    return [...files];
  }, [result]);
  const canReplace = (matches: readonly ProjectSearchMatch[]) => !readOnly && !locked && !loading && !error && !mutationError && !result?.limited
    && !(caseSensitive && query === replacement)
    && matches.some((match) => match.preview.slice(match.matchStart, match.matchEnd) !== replacement);
  const refresh = () => { setMutationError(""); immediateRefresh.current = criteriaKey; setRetry((value) => value + 1); };
  const replaceMatches = async (matches: readonly ProjectSearchMatch[]) => {
    if (busy.current || readOnly || !matches.length) return;
    busy.current = true; setReplacing(true); setMutationError(""); setNotice(null);
    const currentGeneration = generation.current;
    const targets = new Map<string, ProjectReplaceTarget>();
    for (const match of matches) {
      const target = targets.get(match.path) ?? { path: match.path, sourceHash: match.sourceHash, ranges: [] };
      target.ranges.push({ from: match.from, to: match.to });
      targets.set(match.path, target);
    }
    try {
      const value = await api<ProjectReplaceResult>(`/api/projects/${projectId}/search/replace`, { method: "POST",
        body: JSON.stringify({ query, caseSensitive, wholeWord, replacement, targets: [...targets.values()] }) });
      if (generation.current === currentGeneration) { setNotice(value.replaced); refresh(); }
    } catch (reason) {
      if (generation.current === currentGeneration) setMutationError(errorMessage(reason));
    } finally {
      if (generation.current === currentGeneration) { busy.current = false; setReplacing(false); setConfirm(false); }
    }
  };
  const preview = (match: ProjectSearchMatch) => {
    const original = match.preview.slice(match.matchStart, match.matchEnd);
    return <>{match.preview.slice(0, match.matchStart)}
      {!readOnly && replacement ? <><del>{original}</del><ins>{replacement}</ins></> : <mark>{original}</mark>}
      {match.preview.slice(match.matchEnd)}</>;
  };
  return <><Modal open wide className="project-search-modal" title={t(readOnly ? "projectSearch.title" : "projectSearch.replaceTitle")} description={t("projectSearch.scope")}
    onOpenChange={(open) => { if (!open && !busy.current) onClose(); }} footer={<>
      {notice !== null && <div className="project-replace-notice" role="status"><Check size={14} aria-hidden />{t("projectSearch.replaced", { count: notice })}</div>}
      <button type="button" disabled={replacing} onClick={onClose}>{t("common.close")}</button>
    </>}>
    <div className="project-search-controls">
      <div className="project-search-input">
        <Search size={15} aria-hidden />
        <input ref={input} type="text" value={query} disabled={locked} maxLength={PROJECT_SEARCH_MAX_QUERY_LENGTH} spellCheck={false}
          aria-label={t("projectSearch.query")} placeholder={t("projectSearch.query")} onChange={(event) => { setQuery(event.target.value); setNotice(null); setMutationError(""); }} />
        <button type="button" disabled={locked} aria-pressed={caseSensitive} aria-label={t("editor.search.matchCase")} title={t("editor.search.matchCase")} onClick={() => { setCaseSensitive((value) => !value); setMutationError(""); }}><CaseSensitive size={16} aria-hidden /></button>
        <button type="button" disabled={locked} aria-pressed={wholeWord} aria-label={t("editor.search.wholeWord")} title={t("editor.search.wholeWord")} onClick={() => { setWholeWord((value) => !value); setMutationError(""); }}><WholeWord size={16} aria-hidden /></button>
      </div>
      {!readOnly && <div className="project-search-input project-replace-input"><Replace size={15} aria-hidden />
        <input value={replacement} disabled={locked} maxLength={PROJECT_SEARCH_MAX_REPLACEMENT_LENGTH} spellCheck={false}
          aria-label={t("projectSearch.replacement")} placeholder={t("projectSearch.replacement")} onChange={(event) => { setReplacement(event.target.value); setNotice(null); }} />
      </div>}
      <div className="project-search-actions">
      <div className="project-search-summary" id={headingId} role="status" aria-live="polite">
        {result ? <>{t("projectSearch.matches", { count: result.matches.length })}<span aria-hidden>·</span>{t("projectSearch.files", { count: groups.length })}
          {(replacing || loading) && <LoaderCircle className="spin" size={14} aria-label={t(replacing ? "projectSearch.replacing" : "projectSearch.searching")} />}</>
          : replacing || loading ? <><LoaderCircle className="spin" size={14} aria-hidden />{t(replacing ? "projectSearch.replacing" : "projectSearch.searching")}</> : null}
      </div>
      {!readOnly && <button type="button" className="project-replace-all" disabled={!canReplace(result?.matches ?? [])} onClick={() => setConfirm(true)}><ReplaceAll size={14} aria-hidden />{t("projectSearch.replaceAll")}</button>}
      </div>
    </div>
    {(error || mutationError) && <div className="error dialog-error project-search-error" role="alert"><span>{mutationError || error}</span><button type="button" disabled={locked} onClick={refresh}>{t(mutationError ? "projectSearch.refresh" : "common.retry")}</button></div>}
    {result?.limited && <p className="project-search-limit" role="status">{t("projectSearch.limited")}</p>}
    <div className="project-search-results" aria-busy={loading} aria-describedby={headingId}>
      {!query || (result && groups.length === 0) ? <div className="project-search-empty"><FileSearch size={28} aria-hidden /><p>{t(query ? "projectSearch.noMatches" : "projectSearch.empty")}</p></div>
        : groups.map(([path, matches]) => <details key={path} open>
          <summary><ChevronDown size={14} aria-hidden /><FileText size={14} aria-hidden /><span>{path}</span><small>{matches.length}</small></summary>
          <div>{matches.map((match) => <div className="project-search-row" key={`${match.line}:${match.column}`}>
            <button type="button" className="project-search-match" disabled={locked}
              aria-label={t("projectSearch.location", { path, line: match.line, column: match.column })}
              onClick={() => { onNavigate(path, match.line, match.column); onClose(); }}>
              <span className="project-search-line">L{match.line}:{match.column}</span><code>{preview(match)}</code>
            </button>
            {!readOnly && <button type="button" className="project-replace-match" disabled={!canReplace([match])}
              aria-label={t("projectSearch.replaceMatch", { line: match.line, column: match.column })} title={t("projectSearch.replaceMatch", { line: match.line, column: match.column })}
              onClick={() => void replaceMatches([match])}><Replace size={14} aria-hidden /></button>}
          </div>)}</div>
        </details>)}
    </div>
  </Modal><ConfirmDialog open={confirm} title={t("projectSearch.replaceAll")} description={t("projectSearch.confirmReplace", { count: result?.matches.length ?? 0 })}
    confirmLabel={t("projectSearch.replaceAll")} busy={replacing} onCancel={() => setConfirm(false)} onConfirm={() => void replaceMatches(result?.matches ?? [])} /></>;
}
