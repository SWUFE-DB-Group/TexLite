import { NotebookPen } from "lucide-react";
import { useTranslation } from "react-i18next";
import MarkdownContent from "./MarkdownContent";

/** Shared by the unsaved preview and saved notes. Never interpret raw HTML. */
export default function CitationNotesPreview({ notes }: { notes: string }) {
  const { t } = useTranslation();
  return notes.trim() ? <MarkdownContent className="citation-notes-markdown" source={notes} />
    : <div className="citation-notes-empty"><NotebookPen size={26} aria-hidden /><p>{t("citationNotes.empty")}</p></div>;
}
