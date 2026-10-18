import { useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronUp, Tags } from "lucide-react";
import type { CitationLibraryTag } from "./types";

/** Keep the filter catalog compact without hiding the selected filter or keyboard focus. */
export function CitationTagFilters({ tags, selectedId, onSelect, onManage }: {
  tags: CitationLibraryTag[];
  selectedId: string;
  onSelect: (id: string) => void;
  onManage: () => void;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [visibleCount, setVisibleCount] = useState(Number.POSITIVE_INFINITY);
  const [collapsedHeight, setCollapsedHeight] = useState<number>();
  const list = useRef<HTMLDivElement>(null);
  const ordered = selectedId ? [...tags.filter((tag) => tag.id === selectedId), ...tags.filter((tag) => tag.id !== selectedId)] : tags;

  useLayoutEffect(() => {
    const element = list.current;
    if (!element) return;
    const measure = () => {
      const buttons = Array.from(element.querySelectorAll<HTMLButtonElement>("button"));
      const rows = [...new Set(buttons.map((button) => button.offsetTop))];
      const thirdRow = rows[2];
      const visible = thirdRow === undefined ? buttons : buttons.filter((button) => button.offsetTop < thirdRow);
      setVisibleCount(visible.length);
      setCollapsedHeight(visible.length ? Math.max(...visible.map((button) => button.offsetTop + button.offsetHeight)) : undefined);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [tags, selectedId]);

  const overflow = visibleCount < tags.length + 1;
  return <div className="citation-tag-bar">
    <div className="citation-tag-filter-catalog">
      <div className="citation-tag-filter-clip" style={!expanded && overflow ? { maxHeight: collapsedHeight } : undefined}>
        <div className="citation-tag-filters" ref={list}>
          <button type="button" className={!selectedId ? "active" : ""} aria-pressed={!selectedId} onClick={() => onSelect("")}>{t("citationLibrary.allTags")}</button>
          {ordered.map((tag, index) => {
            const hidden = !expanded && index + 1 >= visibleCount;
            return <button type="button" key={tag.id} className={selectedId === tag.id ? "active" : ""} aria-pressed={selectedId === tag.id} aria-hidden={hidden || undefined} tabIndex={hidden ? -1 : 0} title={tag.name} onClick={() => onSelect(selectedId === tag.id ? "" : tag.id)}><span className={`citation-tag-dot tag-${tag.color}`} /><span className="citation-tag-name">{tag.name}</span></button>;
          })}
        </div>
      </div>
      {tags.length === 0 && <span className="muted">{t("citationLibrary.noTags")}</span>}
      {overflow && <button type="button" className="citation-tag-expand" aria-expanded={expanded} onClick={() => setExpanded((current) => !current)}>{expanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}{t(expanded ? "citationTagManagement.collapse" : "citationTagManagement.expand")}</button>}
    </div>
    <button type="button" className="citation-tag-manage" onClick={onManage}><Tags size={14} />{t("citationTagManagement.title")}</button>
  </div>;
}
