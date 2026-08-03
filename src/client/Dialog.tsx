import type { ReactNode } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { useTranslation } from "react-i18next";

interface ModalProps {
  open: boolean;
  title: string;
  description?: string;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
  extraWide?: boolean;
  className?: string;
}

export function Modal({ open, title, description, onOpenChange, children, footer, wide, extraWide, className }: ModalProps) {
  const { t } = useTranslation();
  return <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="dialog-overlay" />
      <DialogPrimitive.Content className={`dialog-content${wide ? " dialog-wide" : ""}${extraWide ? " dialog-extra-wide" : ""}${className ? ` ${className}` : ""}`}>
        <div className="dialog-header">
          <div><DialogPrimitive.Title>{title}</DialogPrimitive.Title>
            {description && <DialogPrimitive.Description>{description}</DialogPrimitive.Description>}
          </div>
          <DialogPrimitive.Close className="dialog-close" aria-label={t("common.close")}>×</DialogPrimitive.Close>
        </div>
        <div className="dialog-body">{children}</div>
        {footer && <div className="dialog-footer">{footer}</div>}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  </DialogPrimitive.Root>;
}

export function ConfirmDialog({ open, title, description, confirmLabel, danger, onCancel, onConfirm }: {
  open: boolean; title: string; description: string; confirmLabel?: string; danger?: boolean;
  onCancel: () => void; onConfirm: () => void;
}) {
  const { t } = useTranslation();
  return <Modal open={open} title={title} description={description} onOpenChange={(next) => { if (!next) onCancel(); }} footer={<>
    <button onClick={onCancel}>{t("common.cancel")}</button>
    <button className={danger ? "danger" : "primary"} onClick={onConfirm}>{confirmLabel ?? t("common.remove")}</button>
  </>}><div /></Modal>;
}
