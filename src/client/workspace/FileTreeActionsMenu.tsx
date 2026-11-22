import { useRef, useState } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Check, FileSearch, FolderPlus, HardDrive, LayoutGrid, MoreHorizontal, Search, Workflow } from "lucide-react";
import { useTranslation } from "react-i18next";

export function FileTreeActionsMenu({ onQuickOpen, onNewFolder, onProjectSearch, onTikzGallery, onNewDrawio, onPrepareDrawio, showFileSizes, onToggleFileSizes }: {
  onQuickOpen: () => void;
  onNewFolder?: () => void;
  onProjectSearch?: () => void;
  onTikzGallery?: () => void;
  onNewDrawio?: () => void;
  onPrepareDrawio?: () => void;
  showFileSizes?: boolean;
  onToggleFileSizes?: () => void;
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
        {onNewDrawio && <DropdownMenu.Item onFocus={onPrepareDrawio} onPointerEnter={onPrepareDrawio}
          onSelect={() => { onPrepareDrawio?.(); select(onNewDrawio); }}><Workflow size={14} aria-hidden />{t("drawio.new")}</DropdownMenu.Item>}
        {onTikzGallery && <DropdownMenu.Item onSelect={() => select(onTikzGallery)}><LayoutGrid size={14} aria-hidden />{t("gallery.title")}</DropdownMenu.Item>}
        {onToggleFileSizes && <>
          <DropdownMenu.Separator className="project-action-menu-separator" />
          <DropdownMenu.CheckboxItem checked={Boolean(showFileSizes)} onSelect={() => onToggleFileSizes()}>
            <HardDrive size={14} aria-hidden />
            <span>{t(showFileSizes ? "editor.hideFileSizes" : "editor.showFileSizes")}</span>
            {showFileSizes && <Check className="file-actions-menu-check" size={13} aria-hidden />}
          </DropdownMenu.CheckboxItem>
        </>}
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  </DropdownMenu.Root>;
}
