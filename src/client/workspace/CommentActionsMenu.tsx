import { useRef } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";

export function CommentActionsMenu({ kind, onEdit, onDelete }: {
  kind: "comment" | "reply";
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  const selecting = useRef(false);
  return <span className="comment-actions-menu" onClick={(event) => event.stopPropagation()}>
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger asChild>
        <button type="button" className="comment-actions-menu-trigger" aria-label={t(kind === "comment" ? "editor.commentActions" : "editor.replyActions")}><MoreHorizontal size={16} aria-hidden /></button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="comment-actions-menu-content" align="end" sideOffset={4} collisionPadding={8}
          onCloseAutoFocus={(event) => {
            // The edit form or confirmation dialog owns focus after an action.
            if (selecting.current) event.preventDefault();
            selecting.current = false;
          }}>
          <DropdownMenu.Item onSelect={() => { selecting.current = true; onEdit(); }}><Pencil size={13} aria-hidden />{t(kind === "comment" ? "editor.editComment" : "editor.editReply")}</DropdownMenu.Item>
          <DropdownMenu.Item className="danger-text" onSelect={() => { selecting.current = true; onDelete(); }}><Trash2 size={13} aria-hidden />{t(kind === "comment" ? "editor.deleteComment" : "editor.deleteReply")}</DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  </span>;
}
