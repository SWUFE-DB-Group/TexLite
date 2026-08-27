import { AlertTriangle, Hash, LoaderCircle, Type } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Modal } from "../Dialog";
import type { WordCountResult } from "../types";
import type { WordCountMode } from "./types";

export interface WordCountDialogProps {
  open: boolean;
  mode: WordCountMode;
  path: string;
  busy: boolean;
  error: string;
  result: WordCountResult | null;
  onOpenChange: (open: boolean) => void;
}

export function WordCountDialog({ open, mode, path, busy, error, result, onOpenChange }: WordCountDialogProps) {
  const { t } = useTranslation();
  const description = mode === "full"
    ? t("editor.wordCountFullHint")
    : t("editor.wordCountSelectionHint");
  return <Modal open={open} title={t("editor.wordCountTitle")} description={description} onOpenChange={onOpenChange} footer={<button type="button" onClick={() => onOpenChange(false)}>{t("common.close")}</button>}>
    {path && <p className="word-count-source">{mode === "full" ? t("editor.wordCountFull") : t("editor.wordCountSelection")} · <code>{path}</code><a href="https://app.uio.no/ifi/texcount/" target="_blank" rel="noreferrer">{t("editor.wordCountHelp")}</a></p>}
    <p className="word-count-template-note">{t("editor.wordCountTemplateNote")}</p>
    {busy && <div className="word-count-loading" role="status" aria-live="polite"><LoaderCircle className="spin" size={22} /><span>{t("editor.wordCountLoading")}</span></div>}
    {error && <p className="error dialog-error">{error}</p>}
    {result && !busy && <div className="word-count-result" aria-live="polite">
      <div className="word-count-totals">
        <div className="word-count-total"><Hash size={20} /><strong>{result.totalWords.toLocaleString()}</strong><span>{t("editor.wordCountTotal")}</span></div>
        <div className="word-count-total word-count-characters"><Type size={20} /><strong>{result.totalCharacters.toLocaleString()}</strong><span>{t("editor.wordCountCharacters")}<small>{t("editor.wordCountCharactersHint")}</small></span></div>
      </div>
      <dl className="word-count-breakdown">
        <div><dt>{t("editor.wordCountText")}</dt><dd>{result.textWords.toLocaleString()}<small>{t("editor.wordCountWordsUnit")}</small></dd></div>
        <div><dt>{t("editor.wordCountHeaders")}</dt><dd>{result.headerWords.toLocaleString()}<small>{t("editor.wordCountWordsUnit")}</small></dd></div>
        <div><dt>{t("editor.wordCountCaptions")}</dt><dd>{result.captionWords.toLocaleString()}<small>{t("editor.wordCountWordsUnit")}</small></dd></div>
        <div><dt>{t("editor.wordCountFloats")}</dt><dd>{result.floats.toLocaleString()}<small>{t("editor.wordCountItemsUnit")}</small></dd></div>
        <div><dt>{t("editor.wordCountInlineMath")}</dt><dd>{result.inlineMath.toLocaleString()}<small>{t("editor.wordCountExpressionsUnit")}</small></dd></div>
        <div><dt>{t("editor.wordCountDisplayMath")}</dt><dd>{result.displayMath.toLocaleString()}<small>{t("editor.wordCountExpressionsUnit")}</small></dd></div>
        {result.files !== null && <div><dt>{t("editor.wordCountFiles")}</dt><dd>{result.files.toLocaleString()}<small>{t("editor.wordCountItemsUnit")}</small></dd></div>}
      </dl>
      {result.parserErrors > 0 && <p className="warning word-count-warning"><AlertTriangle size={14} />{t("editor.wordCountParserErrors", { count: result.parserErrors })}</p>}
    </div>}
  </Modal>;
}
