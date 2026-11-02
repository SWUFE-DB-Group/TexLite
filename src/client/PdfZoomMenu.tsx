import { useRef } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Check, ChevronDown } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { PdfFitMode, PdfZoomState } from "./pdfViewer";

const presets = [25, 50, 75, 100, 125, 150, 200];

export function PdfZoomMenu({ zoom, fitMode, onChange }: PdfZoomState & { onChange: (zoom: number, fitMode: PdfFitMode) => void }) {
  const { t } = useTranslation();
  const trigger = useRef<HTMLButtonElement>(null);
  return <DropdownMenu.Root modal={false}>
    <DropdownMenu.Trigger asChild>
      <button ref={trigger} type="button" className="pdf-zoom-trigger" aria-label={t("editor.pdfZoomOptions")} title={t("editor.pdfZoomOptions")}>
        <span className="pdf-zoom-value" aria-live="polite">{Math.round(zoom)}%</span><ChevronDown size={11} aria-hidden="true" />
      </button>
    </DropdownMenu.Trigger>
    <DropdownMenu.Portal container={trigger.current?.closest<HTMLElement>('[role="dialog"]')}>
      <DropdownMenu.Content className="pdf-zoom-menu" align="start" sideOffset={5} collisionPadding={8} aria-label={t("editor.pdfZoomOptions")}>
        <DropdownMenu.RadioGroup value={fitMode ?? String(zoom)} onValueChange={(value) => {
          const mode = value === "width" || value === "page" ? value : null;
          onChange(mode === "width" ? 100 : mode === "page" ? zoom : Number(value), mode);
        }}>
          {(["width", "page"] as const).map((mode) => <DropdownMenu.RadioItem key={mode} className="pdf-zoom-menu-item" value={mode}>
            <span>{t(mode === "width" ? "editor.pdfFitWidth" : "editor.pdfFitPage")}</span><DropdownMenu.ItemIndicator><Check size={13} aria-hidden="true" /></DropdownMenu.ItemIndicator>
          </DropdownMenu.RadioItem>)}
          <DropdownMenu.Separator className="pdf-zoom-menu-divider" />
          {presets.map((value) => <DropdownMenu.RadioItem key={value} className="pdf-zoom-menu-item" value={String(value)}>
            <span>{value}%</span><DropdownMenu.ItemIndicator><Check size={13} aria-hidden="true" /></DropdownMenu.ItemIndicator>
          </DropdownMenu.RadioItem>)}
        </DropdownMenu.RadioGroup>
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  </DropdownMenu.Root>;
}
