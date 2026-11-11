import { useRef, useState } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Copy, Download, MoreHorizontal, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";

/** The less frequent actions on one file-tree row: download, copy and delete. */
export function FileEntryActionsMenu({ name, downloadUrl, onCopy, onDelete }: {
  name: string;
  downloadUrl: string;
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
          // The delete confirmation owns focus after it opens.
          if (selecting.current) event.preventDefault();
          selecting.current = false;
        }}>
        <DropdownMenu.Item asChild>
          <a href={downloadUrl} download={name} draggable={false}><Download size={14} aria-hidden />{t("editor.downloadResource")}</a>
        </DropdownMenu.Item>
        {onCopy && <DropdownMenu.Item onSelect={onCopy}><Copy size={14} aria-hidden />{t("editor.copyFile")}</DropdownMenu.Item>}
        {onDelete && <DropdownMenu.Item className="danger-text" onSelect={() => { selecting.current = true; onDelete(); }}>
          <Trash2 size={14} aria-hidden />{t("editor.deleteFile")}
        </DropdownMenu.Item>}
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  </DropdownMenu.Root>;
}
