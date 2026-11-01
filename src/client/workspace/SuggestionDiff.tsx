import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { makeSuggestionDiff } from "./suggestionDiff";

/** Inline source diff; compact only unchanged context, never the actual edits. */
export function SuggestionDiff({ original, replacement }: { original: string; replacement: string }) {
  const { t } = useTranslation();
  const [full, setFull] = useState(false);
  const diff = useMemo(() => makeSuggestionDiff(original, replacement), [original, replacement]);
  const compact = !full && diff.some(([kind, text]) => kind === 0 && text.length > 192);
  return <div className="suggestion-diff-view">
    <pre className="suggestion-diff" aria-label={t("suggestions.diff")}>
      {diff.map(([kind, text], index) => kind < 0 ? <del key={index}>{text}</del> : kind > 0 ? <ins key={index}>{text}</ins>
        : <span key={index}>{full || text.length <= 192 ? text : index === 0 ? `…${text.slice(-96)}` : index === diff.length - 1 ? `${text.slice(0, 96)}…` : `${text.slice(0, 48)}…${text.slice(-48)}`}</span>)}
    </pre>
    {(compact || full) && <button type="button" className="suggestion-text-action" onClick={() => setFull(!full)}>{t(full ? "suggestions.collapse" : "suggestions.showFull")}</button>}
  </div>;
}
