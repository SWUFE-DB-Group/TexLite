import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

/** A single tag row: CSS pans overflow on hover; touch/reduced-motion users can scroll. */
export function TagMarquee({ children, className, title, focusable = false }: {
  children: ReactNode;
  className: string;
  title?: string;
  /** Only enable outside an already focusable project-open button. */
  focusable?: boolean;
}) {
  const viewportRef = useRef<HTMLSpanElement>(null);
  const trackRef = useRef<HTMLSpanElement>(null);
  const [overflow, setOverflow] = useState(0);

  useLayoutEffect(() => {
    const viewport = viewportRef.current!, track = trackRef.current!;
    let disposed = false;
    const measure = () => {
      if (!disposed) setOverflow(Math.max(0, track.scrollWidth - viewport.clientWidth));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(viewport); observer.observe(track);
    void document.fonts?.ready.then(measure);
    return () => { disposed = true; observer.disconnect(); };
  }, [children]);

  const overflowing = overflow > 1;
  return <span ref={viewportRef} className={`tag-marquee ${className}`} title={title}
    data-overflow={overflowing ? "true" : undefined} tabIndex={focusable && overflowing ? 0 : undefined}
    style={{ "--tag-marquee-offset": `${-overflow}px`, "--tag-marquee-duration": `${Math.max(4, overflow / 28 + 1)}s` } as CSSProperties}>
    <span ref={trackRef} className="tag-marquee-track">{children}</span>
  </span>;
}
