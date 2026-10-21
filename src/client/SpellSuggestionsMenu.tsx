import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import type { SpellCheckIssue } from "./spellCheck";

export interface WritingSuggestionAnchor {
  left: number;
  top: number;
  bottom: number;
}

/** Viewport coordinates: prefer the space above the affected visual line. */
export function writingSuggestionPosition(
  anchor: WritingSuggestionAnchor, menu: { width: number; height: number },
  viewport: { width: number; height: number }
): { left: number; top: number; maxHeight: number } {
  const margin = 8;
  const gap = 6;
  const above = Math.max(0, anchor.top - gap - margin);
  const below = Math.max(0, viewport.height - anchor.bottom - gap - margin);
  const useAbove = menu.height <= above || above >= below;
  const maxHeight = useAbove ? above : below;
  const height = Math.min(menu.height, maxHeight);
  return {
    left: Math.max(margin, Math.min(anchor.left, viewport.width - menu.width - margin)),
    top: Math.max(margin, useAbove ? anchor.top - gap - height : anchor.bottom + gap),
    maxHeight
  };
}

export function SpellSuggestionsMenu({ issue, anchor, readOnly, onReplace }: {
  issue: SpellCheckIssue;
  anchor: WritingSuggestionAnchor;
  readOnly: boolean;
  onReplace: (replacement: string) => void;
}) {
  const { t } = useTranslation();
  const element = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<ReturnType<typeof writingSuggestionPosition> | null>(null);
  useLayoutEffect(() => {
    if (!element.current) return;
    const measured = element.current.getBoundingClientRect();
    setPosition(writingSuggestionPosition(anchor, measured, { width: window.innerWidth, height: window.innerHeight }));
  }, [anchor, issue, readOnly, t]);

  // Keep viewport coordinates independent of editor panel clipping/transforms.
  return createPortal(<div ref={element} className="spell-suggestions-menu" role="menu"
    aria-label={t("editor.writingSuggestions")}
    style={position ? { ...position, visibility: "visible" } : { left: anchor.left, top: anchor.top, visibility: "hidden" }}
    onMouseDown={(event) => event.stopPropagation()}>
    <div className="spell-suggestions-title">{t("editor.writingSuggestions")}</div>
    {issue.message && <div className="spell-suggestions-message">{issue.message}</div>}
    {issue.suggestions.map((suggestion, index) => <button key={`${suggestion}-${index}`} type="button" role="menuitem" disabled={readOnly}
      title={readOnly ? t("editor.spellCheckReadOnly") : t("editor.replaceWith", { word: suggestion || t("editor.removeText") })}
      onClick={() => onReplace(suggestion)}>{suggestion || t("editor.removeText")}</button>)}
    {issue.suggestions.length === 0 && <span className="spell-suggestions-empty">{t("editor.noWritingSuggestions")}</span>}
    {readOnly && issue.suggestions.length > 0 && <span className="spell-suggestions-readonly">{t("editor.spellCheckReadOnly")}</span>}
  </div>, document.body);
}
