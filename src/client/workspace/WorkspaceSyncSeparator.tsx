import { useLayoutEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { GripVertical } from "lucide-react";
import { Separator } from "react-resizable-panels";

/** Keep SyncTeX controls visually on the separator, outside its drag target. */
export function WorkspaceSyncSeparator({ children, showControls = true }: { children: ReactNode; showControls?: boolean }) {
  const [anchor, setAnchor] = useState<HTMLDivElement | null>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const [revealed, setRevealed] = useState(false);
  useLayoutEffect(() => {
    if (!anchor || !showControls) return;
    const update = () => {
      const rect = anchor.getBoundingClientRect();
      const left = rect.left + rect.width / 2;
      const top = rect.top + rect.height / 2;
      setPosition((current) => current?.left === left && current.top === top ? current : { left, top });
    };
    const observer = new ResizeObserver(update);
    observer.observe(anchor);
    const group = anchor.parentElement;
    if (group) {
      observer.observe(group);
      // Moving either neighboring panel moves the anchor without necessarily
      // changing the separator's own size.
      for (const child of group.children) if (child.hasAttribute("data-panel")) observer.observe(child);
    }
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    update();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [anchor, showControls]);

  return <>
    <Separator className="resize-handle sync-resize-handle" elementRef={setAnchor}
      onPointerEnter={() => setRevealed(true)} onPointerLeave={() => setRevealed(false)}>
      <GripVertical className="resize-grip" size={12} />
    </Separator>
    {showControls && position && createPortal(
      <span className="sync-direction-buttons" data-revealed={revealed ? "true" : undefined} style={{ position: "fixed", ...position }}
        onPointerEnter={() => setRevealed(true)} onPointerLeave={() => setRevealed(false)}>{children}</span>,
      document.body
    )}
  </>;
}
