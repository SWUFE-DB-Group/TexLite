import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, FileSearch, FileText, LoaderCircle, Replace, Search } from "lucide-react";
import { api } from "./api";
import { ConfirmDialog, Modal } from "./Dialog";
import type { FileEntry, Project } from "./types";

interface SearchMatch {
  path: string;
  line: number;
  column: number;
  preview: string;
  matchStart: number;
  matchEnd: number;
}

export function QuickOpenDialog({ open, files, onOpenChange, onOpenFile }: {
  open: boolean;
  files: FileEntry[];
  onOpenChange: (open: boolean) => void;
  onOpenFile: (path: string) => void;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const selectedResult = useRef<HTMLButtonElement>(null);
  const choices = useMemo(() => files.filter((entry) => entry.type === "file")
    .map((entry) => ({ entry, score: fuzzyScore(entry.path, query) }))
    .filter((item) => item.score >= 0).sort((left, right) => right.score - left.score || left.entry.path.localeCompare(right.entry.path)).slice(0, 100), [files, query]);
  useEffect(() => { if (open) { setQuery(""); setSelected(0); window.setTimeout(() => input.current?.focus(), 0); } }, [open]);
  useEffect(() => setSelected((current) => Math.min(current, Math.max(0, choices.length - 1))), [choices.length]);
  useEffect(() => {
    if (!open) return;
    selectedResult.current?.scrollIntoView({ block: "nearest" });
  }, [open, selected]);
  const choose = (path: string) => { onOpenFile(path); onOpenChange(false); };
  return <Modal open={open} wide title={t("navigation.quickOpen")} description={t("navigation.quickOpenDescription")} onOpenChange={onOpenChange}>
    <div className="quick-open-dialog"><label><Search size={16} /><input ref={input} value={query} placeholder={t("navigation.filePlaceholder")} onChange={(event) => { setQuery(event.target.value); setSelected(0); }} onKeyDown={(event) => {
      if (event.key === "ArrowDown") { event.preventDefault(); setSelected((current) => Math.min(choices.length - 1, current + 1)); }
      if (event.key === "ArrowUp") { event.preventDefault(); setSelected((current) => Math.max(0, current - 1)); }
      if (event.key === "Enter" && choices[selected]) { event.preventDefault(); choose(choices[selected].entry.path); }
    }} /></label><div className="quick-open-results">{choices.map(({ entry }, index) => <button ref={index === selected ? selectedResult : undefined} className={index === selected ? "active" : ""} key={entry.path} onMouseEnter={() => setSelected(index)} onClick={() => choose(entry.path)}><FileText size={14} /><span>{entry.path}</span>{index === selected && <Check size={13} />}</button>)}{choices.length === 0 && <p className="muted padded">{t("navigation.noFiles")}</p>}</div></div>
  </Modal>;
}

export function ProjectSearchDialog({ open, project, onOpenChange, onJump }: {
  open: boolean;
  project: Project;
  onOpenChange: (open: boolean) => void;
  onJump: (path: string, line: number, column: number) => void;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [replacement, setReplacement] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [matches, setMatches] = useState<SearchMatch[]>([]);
  const [total, setTotal] = useState(0);
  const [truncated, setTruncated] = useState(false);
  const [busy, setBusy] = useState(false);
  const [replaceConfirm, setReplaceConfirm] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [searchRevision, setSearchRevision] = useState(0);
  const request = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!open) { request.current?.abort(); return; }
    setNotice(""); setError("");
    if (!query.trim()) { setMatches([]); setTotal(0); setTruncated(false); return; }
    const timer = window.setTimeout(() => {
      request.current?.abort();
      const controller = new AbortController();
      request.current = controller; setBusy(true);
      const params = new URLSearchParams({ q: query });
      if (caseSensitive) params.set("caseSensitive", "1");
      if (wholeWord) params.set("wholeWord", "1");
      void api<{ matches: SearchMatch[]; total: number; truncated: boolean }>(`/api/projects/${project.id}/search?${params}`, { signal: controller.signal })
        .then((result) => { setMatches(result.matches); setTotal(result.total); setTruncated(result.truncated); })
        .catch((reason) => { if (!(reason instanceof DOMException && reason.name === "AbortError")) setError(message(reason)); })
        .finally(() => { if (request.current === controller) { request.current = null; setBusy(false); } });
    }, 250);
    return () => window.clearTimeout(timer);
  }, [open, project.id, query, caseSensitive, wholeWord, searchRevision]);

  const replaceAll = async () => {
    setReplaceConfirm(false); setBusy(true); setError(""); setNotice("");
    try {
      const result = await api<{ replacements: number; files: string[] }>(`/api/projects/${project.id}/search/replace`, {
        method: "POST", body: JSON.stringify({ query, replacement, caseSensitive, wholeWord })
      });
      setNotice(t("navigation.replaced", { count: result.replacements, files: result.files.length }));
      setMatches([]); setTotal(0);
      setSearchRevision((current) => current + 1);
    } catch (reason) { setError(message(reason)); }
    finally { setBusy(false); }
  };

  return <><Modal open={open} extraWide title={t("navigation.projectSearch")} description={t("navigation.projectSearchDescription")} onOpenChange={onOpenChange}
    footer={<button onClick={() => onOpenChange(false)}>{t("common.close")}</button>}>
    <div className="project-search-dialog">
      {error && <p className="error">{error}</p>}{notice && <p className="success">{notice}</p>}
      <div className="project-search-form"><label className="project-search-query"><Search size={16} /><input autoFocus value={query} placeholder={t("navigation.searchPlaceholder")} onChange={(event) => setQuery(event.target.value)} /></label>{project.permission !== "read" && <label className="project-search-query"><Replace size={16} /><input value={replacement} placeholder={t("navigation.replacePlaceholder")} onChange={(event) => setReplacement(event.target.value)} /></label>}<div className="project-search-options"><label><input type="checkbox" checked={caseSensitive} onChange={(event) => setCaseSensitive(event.target.checked)} />{t("editor.search.matchCase")}</label><label><input type="checkbox" checked={wholeWord} onChange={(event) => setWholeWord(event.target.checked)} />{t("editor.search.wholeWord")}</label>{project.permission !== "read" && <button className="danger-text" disabled={!query.trim() || total === 0 || busy} onClick={() => setReplaceConfirm(true)}><Replace size={13} />{t("navigation.replaceAll", { count: total })}</button>}</div></div>
      <div className="project-search-summary"><span>{busy ? <><LoaderCircle className="spin" size={13} />{t("common.loading")}</> : t("navigation.matchSummary", { count: total })}</span>{truncated && <small>{t("navigation.truncated", { count: matches.length })}</small>}</div>
      <div className="project-search-results">{matches.map((match, index) => <button key={`${match.path}-${match.line}-${match.column}-${index}`} onClick={() => { onJump(match.path, match.line, match.column); onOpenChange(false); }}><FileSearch size={14} /><span><strong>{match.path}<small>:{match.line}:{match.column}</small></strong><code>{match.preview.slice(0, match.matchStart)}<mark>{match.preview.slice(match.matchStart, match.matchEnd)}</mark>{match.preview.slice(match.matchEnd)}</code></span></button>)}{!busy && query.trim() && matches.length === 0 && <p className="muted padded">{t("editor.search.noMatches")}</p>}</div>
    </div>
  </Modal><ConfirmDialog open={replaceConfirm} title={t("navigation.replaceConfirmTitle")} description={t("navigation.replaceConfirmDescription", { count: total })} confirmLabel={t("navigation.replaceAll", { count: total })} danger onCancel={() => setReplaceConfirm(false)} onConfirm={() => void replaceAll()} /></>;
}

function fuzzyScore(value: string, query: string): number {
  const target = value.toLocaleLowerCase();
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return 1;
  const direct = target.indexOf(needle);
  if (direct >= 0) return 10_000 - direct - target.length;
  let cursor = 0;
  let score = 0;
  for (const character of needle) {
    const index = target.indexOf(character, cursor);
    if (index < 0) return -1;
    score += index === cursor ? 5 : 1;
    cursor = index + 1;
  }
  return score - target.length / 100;
}

function message(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}
