import { useRef, useState } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { CaseSensitive, Copy, Download, MoreHorizontal, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";

/** The less frequent actions on one file-tree row. */
export function FileEntryActionsMenu({ name, downloadUrl, onCopy, onDelete, onInspectFonts }: {
  name: string;
  downloadUrl: string;
  /** PDF files only; also available to read-only members. */
  onInspectFonts?: () => void;
  /** Absent for read-only members. */
  onCopy?: () => void;
  /** Absent for read-only members and for the configured main document. */
  onDelete?: () => void;
}) {
  const { t } = useTranslation();
  const trigger = useRef<HTMLButtonElement>(null);
  const selecting = useRef(false);
  // Opening re-renders, so the portal finds the phone drawer and stays inside
  // its focus scope instead of rendering behind the modal drawer.
  const [open, setOpen] = useState(false);
  const dialog = trigger.current?.closest<HTMLElement>('[role="dialog"]');
  return <DropdownMenu.Root open={open} onOpenChange={setOpen} modal={false}>
    <DropdownMenu.Trigger asChild>
      <button ref={trigger} type="button" className="file-entry-action" title={t("editor.moreActions")}
        aria-label={t("editor.fileActions", { name })} onClick={(event) => event.stopPropagation()}>
        <MoreHorizontal size={13} aria-hidden />
      </button>
    </DropdownMenu.Trigger>
    <DropdownMenu.Portal container={dialog ?? undefined}>
      <DropdownMenu.Content className="file-actions-menu" align="end" sideOffset={4} collisionPadding={8}
        onCloseAutoFocus={(event) => {
          // A newly opened dialog owns focus after selecting its action.
          if (selecting.current) event.preventDefault();
          selecting.current = false;
        }}>
        <DropdownMenu.Item asChild>
          <a href={downloadUrl} download={name} draggable={false}><Download size={14} aria-hidden />{t("editor.downloadResource")}</a>
        </DropdownMenu.Item>
        {onInspectFonts && <DropdownMenu.Item onSelect={() => { selecting.current = true; onInspectFonts(); }}>
          <CaseSensitive size={14} aria-hidden />{t("editor.pdfFonts.inspect")}
        </DropdownMenu.Item>}
        {onCopy && <DropdownMenu.Item onSelect={onCopy}><Copy size={14} aria-hidden />{t("editor.copyFile")}</DropdownMenu.Item>}
        {onDelete && <DropdownMenu.Item className="danger-text" onSelect={() => { selecting.current = true; onDelete(); }}>
          <Trash2 size={14} aria-hidden />{t("editor.deleteFile")}
        </DropdownMenu.Item>}
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  </DropdownMenu.Root>;
}
