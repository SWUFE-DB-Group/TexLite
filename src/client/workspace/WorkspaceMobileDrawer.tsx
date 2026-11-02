import { useRef, type ReactNode } from "react";
import * as Dialog from "@radix-ui/react-dialog";

/** Reuse the panel's own heading/close button, with modal focus and background isolation. */
export function WorkspaceMobileDrawer({ open, title, onClose, children, files = false }: {
  open: boolean; title: string; onClose: () => void; children: ReactNode; files?: boolean;
}) {
  const previousFocus = useRef<HTMLElement | null>(null);
  return <Dialog.Root open={open} onOpenChange={(value) => { if (!value) onClose(); }}>
    <Dialog.Portal>
      <Dialog.Overlay className="workspace-mobile-backdrop" />
      <Dialog.Content className={`workspace-mobile-drawer${files ? " workspace-mobile-files" : ""}`} aria-describedby={undefined}
        onOpenAutoFocus={() => { previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; }}
        onCloseAutoFocus={(event) => { event.preventDefault(); if (previousFocus.current?.isConnected) previousFocus.current.focus(); }}>
        <Dialog.Title className="sr-only">{title}</Dialog.Title>
        {children}
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}
