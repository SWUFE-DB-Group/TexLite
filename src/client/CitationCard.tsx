import type { TFunction } from "i18next";
import { Check, Import, RefreshCw } from "lucide-react";
import { CitationEntryMenu } from "./CitationEntryMenu";
import { SaveButton } from "./SaveButton";
import { citationVenue, type ParsedCitationEntry } from "./citationLibrary";
import type { CitationLibraryEntry } from "./types";
import { TagMarquee } from "./TagMarquee";

/** Entry presentation is shared; project workflows omit all management controls. */
export function CitationCard({ entry, selected, alreadyInFile, saved, saving, saveFeedback, saveDisabled, saveHint, importDisabled, importHint, deleting, manage = true, onSave, onImport, onEdit, onTags, onCollections, onNotes, notesExpanded, notesRegionId, onDelete, t }: {
  entry: ParsedCitationEntry | CitationLibraryEntry;
  selected?: boolean;
  alreadyInFile?: boolean;
  saved?: boolean;
  saving?: boolean;
  saveFeedback?: string;
  saveDisabled?: boolean;
  saveHint?: string;
  importDisabled?: boolean;
  importHint?: string;
  deleting?: boolean;
  manage?: boolean;
  onSave?: () => void;
  onImport?: () => void | Promise<void>;
  onEdit?: () => void;
  onTags?: () => void;
  onCollections?: () => void;
  onNotes?: () => void;
  notesExpanded?: boolean;
  notesRegionId?: string;
  onDelete?: () => void;
  t: TFunction;
}) {
  const libraryEntry = "id" in entry ? entry as CitationLibraryEntry : null;
  const venue = citationVenue(entry);
  const saveLabel = t(saved ? "citationLibrary.update" : "citationLibrary.save");
  const saveTooltip = saving ? t("citationLibrary.saving") : saveFeedback || (saveHint ? `${saveLabel} · ${saveHint}` : saveLabel);
  const importTooltip = alreadyInFile ? t("citationErrors.alreadyInFile", { key: entry.citationKey }) : importHint || t("citationLibrary.importToFile");
  return <article className={`citation-entry-card${selected ? " selected" : ""}${alreadyInFile ? " already-in-file" : ""}`} title={alreadyInFile ? t("citationErrors.alreadyInFile", { key: entry.citationKey }) : undefined}>
    <div className="citation-entry-main">
      <div className="citation-entry-heading"><code>{entry.citationKey}</code><span>@{entry.entryType}</span>{venue && <span className="citation-entry-venue" title={venue}>{venue}</span>}{saved && <em><Check size={11} />{t("citationLibrary.savedLabel")}</em>}</div>
      <strong title={entry.title || t("citationLibrary.untitled")}>{entry.title || t("citationLibrary.untitled")}</strong>
      <p>{entry.authors || t("citationLibrary.authorUnknown")}{entry.year && <span> · {entry.year}</span>}</p>
      {manage && libraryEntry && libraryEntry.tags.length > 0 && <TagMarquee className="citation-entry-tags" focusable>{libraryEntry.tags.map((tag) => <span className={`citation-tag-pill tag-${tag.color}`} key={tag.id}><span className="citation-tag-dot" aria-hidden="true" />{tag.name}</span>)}</TagMarquee>}
    </div>
    <div className="citation-entry-actions">
      {onSave && <SaveButton iconSize={15} icon={!manage && saved ? <RefreshCw size={15} aria-hidden /> : undefined} iconOnly={!manage}
        className={!manage ? "citation-icon-action" : undefined} aria-label={saveLabel} data-tooltip={saveTooltip}
        saving={saving} disabled={saveDisabled} feedback={saveFeedback} onClick={onSave}>{t(saving ? "citationLibrary.saving" : saved ? "citationLibrary.update" : "citationLibrary.save")}</SaveButton>}
      {onImport && <button type="button" className={!manage ? "citation-icon-action" : undefined} aria-label={t("citationLibrary.import")} disabled={importDisabled || alreadyInFile} data-tooltip={importTooltip}
        onClick={() => void onImport()}><Import size={15} aria-hidden /><span className={!manage ? "sr-only" : undefined}>{t("citationLibrary.import")}</span></button>}
      {manage && <CitationEntryMenu citationKey={entry.citationKey} bibtex={entry.bibtex} deleting={deleting} onTags={libraryEntry ? onTags : undefined} onCollections={libraryEntry ? onCollections : undefined} onNotes={libraryEntry ? onNotes : undefined} notesExpanded={notesExpanded} notesRegionId={notesRegionId} onEdit={libraryEntry ? onEdit : undefined} onDelete={libraryEntry ? onDelete : undefined} />}
    </div>
  </article>;
}
