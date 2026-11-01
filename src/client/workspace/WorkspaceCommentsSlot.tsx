import { useCallback, useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from "react";
import { useTranslation } from "react-i18next";
import { scopedStorageKey } from "../basePath";

const DEFAULT_WIDTH = 360;
const MIN_WIDTH = 280;
const MAX_WIDTH = 640;
const widthKey = () => scopedStorageKey("texlite-comments-width");

function readWidth(): number {
  try {
    const saved = Number(window.localStorage.getItem(widthKey()));
    if (Number.isFinite(saved) && saved >= MIN_WIDTH && saved <= MAX_WIDTH) return saved;
  } catch { /* Browser storage is optional. */ }
  return DEFAULT_WIDTH;
}

interface Bounds { min: number; max: number }
interface Drag { pointerId: number; x: number; width: number; preferred: number }
const clamp = (width: number, { min, max }: Bounds) => Math.min(max, Math.max(min, Math.round(width)));

/** A stable portal host: resizing never remounts comments or the PDF viewer. */
export function WorkspaceCommentsSlot({ open, onHost }: { open: boolean; onHost?: (element: HTMLDivElement | null) => void }) {
  const { t } = useTranslation();
  const id = useId();
  const slot = useRef<HTMLDivElement>(null);
  const handle = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const [width, setWidth] = useState(readWidth);
  const widthRef = useRef(width);
  const [resizing, setResizing] = useState(false);
  const [metrics, setMetrics] = useState({ now: width, min: MIN_WIDTH, max: MAX_WIDTH });
  const setHost = useCallback((element: HTMLDivElement | null) => { slot.current = element; onHost?.(element); }, [onHost]);

  const bounds = (): Bounds => {
    const element = slot.current!;
    // CSS owns the inline/drawer breakpoint and the PDF's reserved width.
    const reserve = Number.parseFloat(getComputedStyle(element).getPropertyValue("--comments-preview-reserve")) || 0;
    const max = Math.max(0, Math.min(MAX_WIDTH, Math.floor(element.parentElement!.getBoundingClientRect().width - reserve)));
    return { min: Math.min(MIN_WIDTH, max), max };
  };
  const updateWidth = (next: number) => { widthRef.current = next; setWidth(next); };
  const saveWidth = (next: number) => {
    try { window.localStorage.setItem(widthKey(), String(Math.max(MIN_WIDTH, next))); }
    catch { /* Resizing still works when localStorage is blocked. */ }
  };

  useEffect(() => {
    if (!open) { setResizing(false); return; }
    const element = slot.current!;
    const resizeHandle = handle.current!;
    const measure = () => {
      const next = { now: Math.round(element.getBoundingClientRect().width), ...bounds() };
      setMetrics((current) => current.now === next.now && current.min === next.min && current.max === next.max ? current : next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    observer.observe(element.parentElement!);
    return () => {
      observer.disconnect();
      const current = drag.current;
      drag.current = null;
      if (current && resizeHandle.hasPointerCapture(current.pointerId)) resizeHandle.releasePointerCapture(current.pointerId);
    };
  }, [open]);

  const start = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || drag.current) return;
    event.preventDefault(); event.stopPropagation();
    drag.current = { pointerId: event.pointerId, x: event.clientX, width: slot.current!.getBoundingClientRect().width, preferred: widthRef.current };
    event.currentTarget.setPointerCapture(event.pointerId);
    setResizing(true);
  };
  const move = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    event.preventDefault(); event.stopPropagation();
    updateWidth(clamp(current.width + event.clientX - current.x, bounds()));
  };
  const finish = (event: PointerEvent<HTMLDivElement>, cancel = false) => {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    drag.current = null;
    if (cancel) updateWidth(current.preferred);
    else if (widthRef.current !== current.preferred) saveWidth(widthRef.current);
    setResizing(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const resizeWithKeyboard = (event: KeyboardEvent<HTMLDivElement>) => {
    const range = bounds();
    const current = slot.current!.getBoundingClientRect().width;
    const step = event.shiftKey ? 48 : 16;
    const next = event.key === "ArrowLeft" ? current - step : event.key === "ArrowRight" ? current + step
      : event.key === "Home" ? range.min : event.key === "End" ? range.max : null;
    if (next === null) return;
    event.preventDefault(); event.stopPropagation();
    const value = clamp(next, range);
    updateWidth(value); saveWidth(value);
  };

  return <div ref={setHost} id={id} className="workspace-comments-slot" hidden={!open} data-resizing={resizing || undefined}
    style={{ "--workspace-comments-width": `${width}px` } as CSSProperties}>
    {open && <div ref={handle} className="comments-resize-handle" role="separator" tabIndex={0} aria-orientation="vertical"
      aria-label={t("editor.resizeComments")} aria-controls={id} aria-valuemin={metrics.min} aria-valuemax={metrics.max} aria-valuenow={metrics.now}
      aria-valuetext={`${metrics.now} px`} onPointerDown={start} onPointerMove={move} onPointerUp={finish}
      onPointerCancel={(event) => finish(event, true)} onLostPointerCapture={(event) => finish(event, true)} onKeyDown={resizeWithKeyboard}
      onDoubleClick={(event) => { event.preventDefault(); event.stopPropagation(); updateWidth(DEFAULT_WIDTH); saveWidth(DEFAULT_WIDTH); }} />}
  </div>;
}
