import { useRef, useState } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { FileSearch, FolderPlus, MoreHorizontal, Search } from "lucide-react";
import { useTranslation } from "react-i18next";

export function FileTreeActionsMenu({ onQuickOpen, onNewFolder, onProjectSearch }: {
  onQuickOpen: () => void;
  onNewFolder?: () => void;
  onProjectSearch?: () => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const selecting = useRef(false);
  const select = (action: () => void) => { selecting.current = true; action(); };
  // Keep the menu inside the phone drawer's focus scope, but outside its clipped toolbar.
  const dialog = trigger.current?.closest<HTMLElement>('[role="dialog"]');
  return <DropdownMenu.Root open={open} onOpenChange={setOpen} modal={false}>
    <DropdownMenu.Trigger asChild>
      <button ref={trigger} type="button" className="file-tools-more" aria-label={t("editor.moreActions")} title={t("editor.moreActions")}>
        <MoreHorizontal size={15} aria-hidden />
      </button>
    </DropdownMenu.Trigger>
    <DropdownMenu.Portal container={dialog ?? undefined}>
      <DropdownMenu.Content className="file-actions-menu" align="end" sideOffset={5} collisionPadding={8}
        onCloseAutoFocus={(event) => {
          // The selected action opens a dialog which owns the next focus target.
          if (selecting.current) event.preventDefault();
          selecting.current = false;
        }}>
        <DropdownMenu.Item onSelect={() => select(onQuickOpen)}><FileSearch size={14} aria-hidden />{t("navigation.quickOpen")}</DropdownMenu.Item>
        {onProjectSearch && <DropdownMenu.Item onSelect={() => select(onProjectSearch)}><Search size={14} aria-hidden />{t("projectSearch.title")}</DropdownMenu.Item>}
        {onNewFolder && <DropdownMenu.Item onSelect={() => select(onNewFolder)}><FolderPlus size={14} aria-hidden />{t("editor.newFolder")}</DropdownMenu.Item>}
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  </DropdownMenu.Root>;
}
