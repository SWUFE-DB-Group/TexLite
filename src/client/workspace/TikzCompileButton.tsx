import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Check, ChevronDown, FileOutput, LoaderCircle } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { LatexEngine, TikzFigurePdfState } from "./useTikzFigurePdf";

interface TikzCompileButtonProps {
  state: TikzFigurePdfState;
  disabled: boolean;
  engine: LatexEngine;
  engines: LatexEngine[];
  onEngineChange: (engine: LatexEngine) => void;
  onCompile: () => void;
}

/** Compiles the figure to a PDF beside its source, with the engine chosen from the attached menu. */
export function TikzCompileButton({ state, disabled, engine, engines, onEngineChange, onCompile }: TikzCompileButtonProps) {
  const { t } = useTranslation();
  const compiling = state?.status === "compiling";
  return <div className="tikz-compile-pdf">
    <button type="button" disabled={disabled || compiling} onClick={onCompile}>
      {compiling ? <LoaderCircle className="spin" size={13} aria-hidden /> : state?.status === "saved" ? <Check className="save-button-confirmation" size={13} aria-hidden /> : <FileOutput size={13} aria-hidden />}
      <span role="status" aria-live="polite">{state?.status === "saved" ? t("editor.tikz.pdfSaved", { file: state.file }) : t("editor.tikz.compilePdf")}</span>
    </button>
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger asChild>
        <button type="button" className="tikz-engine-trigger" disabled={compiling} aria-label={t("editor.tikz.chooseEngine")} title={t("editor.tikz.chooseEngine")}>{engine}<ChevronDown size={12} aria-hidden /></button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="file-actions-menu" align="end" sideOffset={5} collisionPadding={8}>
          <DropdownMenu.RadioGroup value={engine} onValueChange={(value) => onEngineChange(value as LatexEngine)}>
            {engines.map((item) => <DropdownMenu.RadioItem key={item} value={item}>
              <span className="tikz-engine-check"><DropdownMenu.ItemIndicator><Check size={14} aria-hidden /></DropdownMenu.ItemIndicator></span>{item}
            </DropdownMenu.RadioItem>)}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  </div>;
}
