import { useEffect, useRef, useState } from "react";

type TooltipPlacement = "above" | "below";

interface TooltipState {
  text: string;
  left: number;
  top: number;
  placement: TooltipPlacement;
}

interface TooltipRect {
  top: number;
  bottom: number;
  left: number;
  width: number;
}

const savedTitleAttribute = "data-texlite-tooltip-title";
const tooltipSelector = `[data-tooltip], [title], [${savedTitleAttribute}]`;

export function globalTooltipPosition(rect: TooltipRect, viewportWidth: number): Omit<TooltipState, "text"> {
  const preferredHalfWidth = Math.min(160, Math.max(16, (viewportWidth - 16) / 2));
  const center = rect.left + rect.width / 2;
  const left = Math.max(preferredHalfWidth, Math.min(center, viewportWidth - preferredHalfWidth));
  const placement: TooltipPlacement = rect.top >= 64 ? "above" : "below";
  return { left, top: placement === "above" ? rect.top - 8 : rect.bottom + 8, placement };
}

function tooltipText(element: HTMLElement): string | null {
  const text = element.getAttribute("data-tooltip")
    ?? element.getAttribute("title")
    ?? element.getAttribute(savedTitleAttribute);
  return text?.trim() || null;
}

function tooltipTarget(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) return null;
  const element = target.closest<HTMLElement>(tooltipSelector);
  return element && tooltipText(element) ? element : null;
}

function suppressNativeTitle(element: HTMLElement): void {
  const title = element.getAttribute("title");
  if (title === null || element.hasAttribute(savedTitleAttribute)) return;
  element.setAttribute(savedTitleAttribute, title);
  element.removeAttribute("title");
}

function restoreNativeTitle(element: HTMLElement | null): void {
  if (!element) return;
  const title = element.getAttribute(savedTitleAttribute);
  if (title === null) return;
  if (!element.hasAttribute("title")) element.setAttribute("title", title);
  element.removeAttribute(savedTitleAttribute);
}

/**
 * Browsers choose the placement of native `title` popups and commonly put
 * them below compact workspace controls. Capture title-bearing elements once
 * and render a single, keyboard-accessible application tooltip instead.
 */
export function GlobalTooltip() {
  const active = useRef<HTMLElement | null>(null);
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);

  useEffect(() => {
    let pointerTarget: HTMLElement | null = null;
    let focusTarget: HTMLElement | null = null;

    const updateActive = () => {
      const next = pointerTarget ?? focusTarget;
      if (next === active.current) {
        if (!next) return;
        const text = tooltipText(next);
        if (!text) return;
        setTooltip({ text, ...globalTooltipPosition(next.getBoundingClientRect(), window.innerWidth) });
        return;
      }
      restoreNativeTitle(active.current);
      active.current = next;
      if (!next) {
        setTooltip(null);
        return;
      }
      const text = tooltipText(next);
      if (!text) {
        setTooltip(null);
        return;
      }
      suppressNativeTitle(next);
      setTooltip({ text, ...globalTooltipPosition(next.getBoundingClientRect(), window.innerWidth) });
    };

    const refreshPosition = () => {
      const element = active.current;
      if (!element) return;
      const text = tooltipText(element);
      if (!text) return;
      setTooltip({ text, ...globalTooltipPosition(element.getBoundingClientRect(), window.innerWidth) });
    };

    const remainsWithin = (element: HTMLElement, related: EventTarget | null) => related instanceof Node && element.contains(related);
    const onPointerOver = (event: PointerEvent) => {
      pointerTarget = tooltipTarget(event.target);
      updateActive();
    };
    const onPointerOut = (event: PointerEvent) => {
      const leaving = tooltipTarget(event.target);
      if (!leaving || leaving !== pointerTarget) return;
      const entering = tooltipTarget(event.relatedTarget);
      if (entering === leaving || remainsWithin(leaving, event.relatedTarget)) return;
      pointerTarget = null;
      updateActive();
    };
    const onFocusIn = (event: FocusEvent) => {
      focusTarget = tooltipTarget(event.target);
      updateActive();
    };
    const onFocusOut = (event: FocusEvent) => {
      const leaving = tooltipTarget(event.target);
      if (!leaving || leaving !== focusTarget || remainsWithin(leaving, event.relatedTarget)) return;
      focusTarget = null;
      updateActive();
    };

    document.addEventListener("pointerover", onPointerOver, true);
    document.addEventListener("pointerout", onPointerOut, true);
    document.addEventListener("focusin", onFocusIn, true);
    document.addEventListener("focusout", onFocusOut, true);
    window.addEventListener("resize", refreshPosition);
    window.addEventListener("scroll", refreshPosition, true);
    return () => {
      document.removeEventListener("pointerover", onPointerOver, true);
      document.removeEventListener("pointerout", onPointerOut, true);
      document.removeEventListener("focusin", onFocusIn, true);
      document.removeEventListener("focusout", onFocusOut, true);
      window.removeEventListener("resize", refreshPosition);
      window.removeEventListener("scroll", refreshPosition, true);
      restoreNativeTitle(active.current);
      active.current = null;
    };
  }, []);

  if (!tooltip) return null;
  return <div id="texlite-global-tooltip" role="tooltip" className={`global-tooltip ${tooltip.placement}`} style={{ left: tooltip.left, top: tooltip.top }}>{tooltip.text}</div>;
}
