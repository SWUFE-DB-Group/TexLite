import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { BookOpen, FileText, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { clampTabDrag, tabDropIndex, tabShift, type TabSlot } from "./editorTabOrder";

const DRAG_THRESHOLD_PX = 4;
const AUTO_SCROLL_EDGE_PX = 28;
const AUTO_SCROLL_STEP_PX = 8;

interface DragSession {
  pointerId: number; path: string; from: number; to: number;
  startX: number; lastX: number; startScroll: number;
  /** Measured when the pointer has moved far enough to be a drag. */
  slots: TabSlot[] | null;
}

function measureSlots(strip: HTMLElement): TabSlot[] {
  const left = strip.getBoundingClientRect().left;
  return Array.from(strip.children).map((child) => {
    const rect = child.getBoundingClientRect();
    return { left: rect.left - left + strip.scrollLeft, width: rect.width };
  });
}

export function EditorTabs({ openTabs, activeFile, projectMainFile, activateTab, closeTab, handleTabKeyDown, reorderTab }: {
  openTabs: string[];
  activeFile: string;
  projectMainFile: string;
  activateTab: (path: string) => void;
  closeTab: (path: string) => void;
  handleTabKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => void;
  reorderTab: (path: string, to: number) => void;
}) {
  const { t } = useTranslation();
  const strip = useRef<HTMLDivElement>(null);
  const session = useRef<DragSession | null>(null);
  const suppressClick = useRef(false);
  // Only this strip re-renders during a drag. The tab order is committed on
  // release, which also keeps the captured element from moving in the DOM.
  const [drag, setDrag] = useState<{ from: number; to: number; offset: number; slots: TabSlot[] } | null>(null);
  const dragging = drag !== null;

  const updateDrag = () => {
    const current = session.current;
    if (!current?.slots || !strip.current) return;
    const offset = clampTabDrag(current.slots, current.from,
      current.lastX - current.startX + strip.current.scrollLeft - current.startScroll);
    current.to = tabDropIndex(current.slots, current.from, offset);
    setDrag({ from: current.from, to: current.to, offset, slots: current.slots });
  };

  const finishDrag = (commit: boolean) => {
    const current = session.current;
    session.current = null;
    if (!current?.slots) return;
    suppressClick.current = true;
    if (strip.current?.hasPointerCapture(current.pointerId)) strip.current.releasePointerCapture(current.pointerId);
    setDrag(null);
    if (!commit) return;
    if (current.to !== current.from) reorderTab(current.path, current.to);
    // A browser brings the tab you drag to the front. Waiting for the drop
    // avoids reloading the editor while the tab is still moving.
    if (current.path !== activeFile) activateTab(current.path);
  };

  // A collaborator's rename or deletion can change the tabs under the pointer.
  useEffect(() => { finishDrag(false); }, [openTabs]);

  // Until a press becomes a drag the strip has no capture, so a release over
  // the editor never reaches it. A leftover press must not revive as a drag.
  useEffect(() => {
    const endPress = (event: PointerEvent) => {
      if (session.current && !session.current.slots && session.current.pointerId === event.pointerId) session.current = null;
    };
    const events = ["pointerdown", "pointerup", "pointercancel"] as const;
    for (const name of events) window.addEventListener(name, endPress, true);
    return () => { for (const name of events) window.removeEventListener(name, endPress, true); };
  }, []);

  useEffect(() => {
    if (!dragging) return;
    let frame = window.requestAnimationFrame(function scroll() {
      const element = strip.current;
      const current = session.current;
      if (element && current) {
        const { left, right } = element.getBoundingClientRect();
        const step = current.lastX < left + AUTO_SCROLL_EDGE_PX ? -AUTO_SCROLL_STEP_PX : current.lastX > right - AUTO_SCROLL_EDGE_PX ? AUTO_SCROLL_STEP_PX : 0;
        const before = element.scrollLeft;
        if (step) element.scrollLeft += step;
        if (element.scrollLeft !== before) updateDrag();
      }
      frame = window.requestAnimationFrame(scroll);
    });
    const cancelOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      finishDrag(false);
    };
    document.addEventListener("keydown", cancelOnEscape, true);
    return () => { window.cancelAnimationFrame(frame); document.removeEventListener("keydown", cancelOnEscape, true); };
  }, [dragging]);

  const startPress = (event: ReactPointerEvent<HTMLDivElement>, path: string, index: number) => {
    suppressClick.current = false;
    // A finger on the strip scrolls it, and a tab's close button stays a button.
    if (event.button !== 0 || event.pointerType === "touch" || openTabs.length < 2 || (event.target as Element).closest(".editor-tab-close")) return;
    session.current = { pointerId: event.pointerId, path, from: index, to: index, startX: event.clientX, lastX: event.clientX, startScroll: strip.current!.scrollLeft, slots: null };
  };
  const movePointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = session.current;
    if (!current || current.pointerId !== event.pointerId) return;
    if (!current.slots && event.buttons === 0) { session.current = null; return; }
    current.lastX = event.clientX;
    if (!current.slots) {
      if (Math.abs(event.clientX - current.startX) < DRAG_THRESHOLD_PX) return;
      current.slots = measureSlots(event.currentTarget);
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    updateDrag();
  };
  const endPointer = (event: ReactPointerEvent<HTMLDivElement>, commit: boolean) => {
    if (session.current?.pointerId === event.pointerId) finishDrag(commit);
  };

  return <div className="editor-tabs-bar" role="tablist" aria-label={t("editor.openFiles")}>
    <div ref={strip} className={`editor-tabs-scroll${dragging ? " reordering" : ""}`}
      onPointerMove={movePointer} onPointerUp={(event) => endPointer(event, true)} onPointerCancel={(event) => endPointer(event, false)}
      onLostPointerCapture={(event) => endPointer(event, false)}
      onClickCapture={(event) => {
        // The click ending a drag is not a request to open or close anything.
        // A keyboard activation has detail 0 and is never part of a drag.
        if (!suppressClick.current || event.detail === 0) return;
        suppressClick.current = false;
        event.preventDefault();
        event.stopPropagation();
      }}>
      {openTabs.map((tabPath, index) => {
        const isActive = tabPath === activeFile;
        // The visible main-document badge reflects the shared project
        // setting. `activeMainFile` can deliberately vary per user for
        // compilation, so using it here made the UI appear to change
        // the project's configured main document when a tab was opened.
        const isMain = tabPath === projectMainFile;
        const fileName = tabPath.split("/").at(-1) || tabPath;
        const isDragged = drag?.from === index;
        const offset = !drag ? 0 : isDragged ? drag.offset : tabShift(drag.slots, drag.from, drag.to, index);
        return <div className={`editor-tab-item${isActive ? " active" : ""}${isDragged ? " dragging" : ""}`} role="presentation" key={tabPath}
          style={offset ? { transform: `translateX(${offset}px)` } : undefined} onPointerDown={(event) => startPress(event, tabPath, index)}>
          <button id={`editor-tab-${encodeURIComponent(tabPath)}`} type="button" role="tab" aria-selected={isActive} aria-controls="editor-source-content" tabIndex={isActive ? 0 : -1} className={`editor-tab${isActive ? " active" : ""}${isMain ? " main-tab" : ""}`} onClick={() => activateTab(tabPath)} onKeyDown={(event) => handleTabKeyDown(event, index)} title={tabPath}>
            <span className="editor-tab-icon">{isMain ? <BookOpen size={13} /> : <FileText size={13} />}</span>
            <span className="editor-tab-title">{fileName}</span>
            {isMain && <small className="editor-tab-badge">{t("editor.currentMainShort")}</small>}
          </button>
          <button type="button" className="editor-tab-close" title={t("common.close")} aria-label={`${t("common.close")} ${fileName}`} onClick={() => closeTab(tabPath)}><X size={12} /></button>
        </div>;
      })}
    </div>
  </div>;
}
