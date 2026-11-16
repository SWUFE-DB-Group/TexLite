import { useEffect, useId, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { ChevronDown, FileDown, LoaderCircle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { SaveButton } from "../SaveButton";
import type { DrawioExportOptions } from "../../shared/drawio";

export function DrawioExportButton({ disabled, saving, feedback, onExport, checkSelection }: {
  disabled: boolean; saving: boolean; feedback: string; onExport: (options: DrawioExportOptions) => void;
  checkSelection: (signal: AbortSignal) => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [scope, setScope] = useState<DrawioExportOptions["scope"]>("page");
  const [margin, setMargin] = useState("0");
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<boolean | null>(null);
  const [checkFailed, setCheckFailed] = useState(false);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setSelected(null); setCheckFailed(false);
    void checkSelection(controller.signal).then((value) => {
      if (!controller.signal.aborted) setSelected(value);
    }).catch(() => { if (!controller.signal.aborted) setCheckFailed(true); });
    return () => controller.abort();
  }, [open, checkSelection]);
  const validMargin = margin.trim() !== "" && Number.isInteger(Number(margin)) && Number(margin) >= 0 && Number(margin) <= 100;
  return <div className="drawio-export-button">
    <SaveButton saving={saving} disabled={disabled || !validMargin} icon={<FileDown size={14} aria-hidden />} feedback={feedback}
      onClick={() => onExport({ scope, margin: Number(margin) })}>{t("drawio.export")}</SaveButton>
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild><button type="button" className="drawio-export-trigger" disabled={disabled || saving}
        aria-label={t("drawio.exportOptions")} title={t("drawio.exportOptions")}>
        {t(scope === "page" ? "drawio.currentPage" : "drawio.selection")}<ChevronDown size={12} aria-hidden />
      </button></Popover.Trigger>
      <Popover.Portal><Popover.Content className="drawio-export-options" align="end" sideOffset={5} collisionPadding={8} aria-label={t("drawio.exportOptions")}>
        <fieldset><legend>{t("drawio.exportScope")}</legend>
          {(["page", "selection"] as const).map((value) => <label key={value}>
            <input type="radio" name={id} value={value} checked={scope === value} disabled={value === "selection" && selected !== true}
              onChange={() => setScope(value)} />
            {t(value === "page" ? "drawio.currentPage" : "drawio.selection")}
            {value === "selection" && selected === null && !checkFailed && <LoaderCircle className="spin" size={12} aria-hidden />}
          </label>)}
          {checkFailed && <p className="error" role="alert">{t("drawio.selectionCheckFailed")}</p>}
        </fieldset>
        <div className="drawio-export-margin">
          <label htmlFor={`${id}-margin`}>{t("drawio.margin")}</label>
          <div className="drawio-export-margin-value"><input id={`${id}-margin`} type="number" min={0} max={100} step={1} value={margin} aria-invalid={!validMargin}
            aria-describedby={!validMargin ? `${id}-error` : undefined} onChange={(event) => setMargin(event.target.value)} /><span>px</span></div>
        </div>
        {!validMargin && <p id={`${id}-error`} className="error" role="alert">{t("drawio.invalidMargin")}</p>}
      </Popover.Content></Popover.Portal>
    </Popover.Root>
  </div>;
}
