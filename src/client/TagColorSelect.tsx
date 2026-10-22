import { useEffect, useRef, useState } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Check, ChevronDown } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { TagColor } from "./types";

const colors: TagColor[] = ["red", "orange", "yellow", "green", "blue", "purple", "gray"];

/** Share the same color swatches in project and citation tag management. */
export function TagColorSelect({ value, onChange, disabled = false }: {
  value: TagColor;
  onChange: (color: TagColor) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);

  return <DropdownMenu.Root modal={false} open={open} onOpenChange={setOpen}>
    <DropdownMenu.Trigger asChild>
      <button ref={trigger} type="button" className="tag-color-select" disabled={disabled} aria-label={`${t("tags.color")}: ${t(`tags.${value}`)}`}>
        <span className={`tag-dot tag-${value}`} aria-hidden="true" /><span>{t(`tags.${value}`)}</span><ChevronDown size={13} aria-hidden="true" />
      </button>
    </DropdownMenu.Trigger>
    {/* Stay inside the dialog's focus trap, but outside its scrollable body. */}
    <DropdownMenu.Portal container={trigger.current?.closest<HTMLElement>('[role="dialog"]')}>
      <DropdownMenu.Content className="tag-color-options" align="start" sideOffset={4} collisionPadding={8}>
        <DropdownMenu.RadioGroup value={value} onValueChange={(next) => { if (!disabled) onChange(next as TagColor); }} aria-label={t("tags.color")}>
          {colors.map((color) => <DropdownMenu.RadioItem className="tag-color-option" key={color} value={color} disabled={disabled}>
            <span className={`tag-dot tag-${color}`} aria-hidden="true" /><span>{t(`tags.${color}`)}</span><DropdownMenu.ItemIndicator className="tag-color-option-check"><Check size={13} aria-hidden="true" /></DropdownMenu.ItemIndicator>
          </DropdownMenu.RadioItem>)}
        </DropdownMenu.RadioGroup>
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  </DropdownMenu.Root>;
}
