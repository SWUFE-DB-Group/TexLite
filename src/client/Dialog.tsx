import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { useTranslation } from "react-i18next";
import { LoaderCircle } from "lucide-react";

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
  /** Enables pointer dragging from the title bar for large workspace dialogs. */
  draggable?: boolean;
}

interface DragOffset { x: number; y: number }
interface DragState extends DragOffset { pointerId: number; clientX: number; clientY: number }

export function Modal({ open, title, description, onOpenChange, children, footer, wide, extraWide, className, draggable = false }: ModalProps) {
  const { t } = useTranslation();
  const contentRef = useRef<HTMLDivElement>(null);
  const dragState = useRef<DragState | null>(null);
  const [offset, setOffset] = useState<DragOffset>({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    if (open) return;
    dragState.current = null;
    setDragging(false);
    setOffset({ x: 0, y: 0 });
  }, [open]);

  const startDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!draggable || event.button !== 0 || event.pointerType === "touch" || isInteractiveTarget(event.target)) return;
    dragState.current = { pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY, ...offset };
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
    event.preventDefault();
  };

  const moveDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const state = dragState.current;
    if (!state || state.pointerId !== event.pointerId) return;
    const element = contentRef.current;
    if (!element) return;
    const rect = element.getBoundingClientRect();
    const maxX = Math.max(0, (window.innerWidth - rect.width) / 2 - 12);
    const maxY = Math.max(0, (window.innerHeight - rect.height) / 2 - 12);
    setOffset({
      x: clamp(state.x + event.clientX - state.clientX, -maxX, maxX),
      y: clamp(state.y + event.clientY - state.clientY, -maxY, maxY)
    });
  };

  const endDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragState.current?.pointerId !== event.pointerId) return;
    dragState.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const contentStyle = draggable ? {
    "--dialog-drag-x": `${offset.x}px`,
    "--dialog-drag-y": `${offset.y}px`
  } as CSSProperties : undefined;

  return <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="dialog-overlay" />
      <DialogPrimitive.Content ref={contentRef} style={contentStyle} data-dragging={dragging || undefined} className={`dialog-content${wide ? " dialog-wide" : ""}${extraWide ? " dialog-extra-wide" : ""}${draggable ? " dialog-draggable" : ""}${className ? ` ${className}` : ""}`}>
        <div className={`dialog-header${draggable ? " dialog-drag-handle" : ""}`} onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag} onLostPointerCapture={endDrag}>
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

function isInteractiveTarget(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest("button, a, input, select, textarea, [data-dialog-no-drag]"));
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function ConfirmDialog({ open, title, description, confirmLabel, danger, onCancel, onConfirm, error, busy = false }: {
  open: boolean; title: string; description: string; confirmLabel?: string; danger?: boolean;
  onCancel: () => void; onConfirm: () => void; error?: string; busy?: boolean;
}) {
  const { t } = useTranslation();
  return <Modal open={open} title={title} description={description} onOpenChange={(next) => { if (!next && !busy) onCancel(); }} footer={<>
    <button disabled={busy} onClick={onCancel}>{t("common.cancel")}</button>
    <button className={danger ? "danger" : "primary"} disabled={busy} aria-busy={busy} onClick={onConfirm}>{busy && <LoaderCircle className="spin" size={14} />}{confirmLabel ?? t("common.remove")}</button>
  </>}><>{error && <p className="error dialog-error">{error}</p>}<div /></></Modal>;
}
