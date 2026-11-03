import { lazy, Suspense, useId, useRef, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { Eye, LibraryBig, NotebookPen } from "lucide-react";

const CitationNotesPreview = lazy(() => import("./CitationNotesPreview"));
const CitationBibtexEditor = lazy(() => import("./CitationBibtexEditor"));
const tabs = ["bibtex", "notes", "preview"] as const;
type CitationTab = typeof tabs[number];

/** Tabs share controlled drafts; switching views never changes saved content. */
export function CitationContentFields({ bibtex, notes, disabled, autoFocus, onBibtex, onNotes }: {
  bibtex: string;
  notes: string;
  disabled?: boolean;
  autoFocus?: boolean;
  onBibtex: (value: string) => void;
  onNotes: (value: string) => void;
}) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<CitationTab>("bibtex");
  const id = useId();
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);
  const labels = { bibtex: "BibTeX", notes: t("citationNotes.tab"), preview: t("citationNotes.preview") };
  const icons = { bibtex: LibraryBig, notes: NotebookPen, preview: Eye };
  const navigate = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const next = event.key === "ArrowRight" ? (index + 1) % tabs.length
      : event.key === "ArrowLeft" ? (index + tabs.length - 1) % tabs.length
        : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : null;
    if (next === null) return;
    event.preventDefault(); setTab(tabs[next]); buttons.current[next]?.focus();
  };
  return <div className="citation-content-fields">
    <div className="citation-content-tabs" role="tablist" aria-label={t("citationNotes.editorTabs")}>
      {tabs.map((name, index) => {
        const Icon = icons[name];
        return <button key={name} ref={(button) => { buttons.current[index] = button; }} type="button" role="tab"
          id={`${id}-${name}-tab`} aria-controls={`${id}-${name}-panel`} aria-selected={tab === name} tabIndex={tab === name ? 0 : -1}
          onClick={() => setTab(name)} onKeyDown={(event) => navigate(event, index)}><Icon size={14} aria-hidden />{labels[name]}</button>;
      })}
    </div>
    <div className="citation-content-panel" role="tabpanel" id={`${id}-bibtex-panel`} aria-labelledby={`${id}-bibtex-tab`} hidden={tab !== "bibtex"}>
      <Suspense fallback={<div className="citation-bibtex-loading" role="status">{t("common.loading")}</div>}>
        <CitationBibtexEditor value={bibtex} disabled={disabled} autoFocus={autoFocus} active={tab === "bibtex"} onChange={onBibtex} placeholder={t("citationLibraryActions.addEntryPlaceholder")} />
      </Suspense>
    </div>
    <div className="citation-content-panel" role="tabpanel" id={`${id}-notes-panel`} aria-labelledby={`${id}-notes-tab`} hidden={tab !== "notes"}>
      <textarea aria-label={t("citationNotes.optional")} className="citation-notes-input" value={notes} disabled={disabled}
        onChange={(event) => onNotes(event.target.value)} placeholder={t("citationNotes.placeholder")} rows={12} />
    </div>
    <div className="citation-content-panel citation-content-preview" role="tabpanel" id={`${id}-preview-panel`} aria-labelledby={`${id}-preview-tab`} hidden={tab !== "preview"} tabIndex={0}>
      {tab === "preview" && <Suspense fallback={<p role="status">{t("common.loading")}</p>}><CitationNotesPreview notes={notes} /></Suspense>}
    </div>
  </div>;
}
