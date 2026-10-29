import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";

/** Measure only layout changes; CSS animates overflowing names without React updates. */
export function WorkspaceProjectTitle({ name }: { name: string }) {
  const viewportRef = useRef<HTMLElement>(null);
  const textRef = useRef<HTMLSpanElement>(null);
  const [overflow, setOverflow] = useState(0);

  useLayoutEffect(() => {
    const viewport = viewportRef.current!;
    const text = textRef.current!;
    let disposed = false;
    const measure = () => {
      if (!disposed) setOverflow(Math.max(0, text.scrollWidth - viewport.clientWidth));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(viewport); observer.observe(text);
    void document.fonts?.ready.then(measure);
    return () => { disposed = true; observer.disconnect(); };
  }, [name]);

  const overflowing = overflow > 1;
  return <strong ref={viewportRef} className="workspace-project-title" data-overflow={overflowing ? "true" : undefined}
    tabIndex={overflowing ? 0 : undefined} style={{
      "--project-title-offset": `${-overflow}px`,
      "--project-title-duration": `${Math.max(4, overflow / 32 + 1.5)}s`
    } as CSSProperties}>
    <span ref={textRef}>{name}</span>
  </strong>;
}
