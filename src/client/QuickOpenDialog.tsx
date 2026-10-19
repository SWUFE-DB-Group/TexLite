import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, FileText, Search } from "lucide-react";
import { Modal } from "./Dialog";
import type { FileEntry } from "./types";

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

