import { useEffect, useLayoutEffect, useRef, useState } from "react";

type TooltipPlacement = "above";

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
const disabledTooltipRegionSelector = '[data-texlite-tooltips="off"]';
const alwaysEnabledTooltipSelector = "[data-texlite-tooltip-always]";

export function globalTooltipPosition(rect: TooltipRect, viewportWidth: number): Omit<TooltipState, "text"> {
  const preferredHalfWidth = Math.min(160, Math.max(16, (viewportWidth - 16) / 2));
  const center = rect.left + rect.width / 2;
  const left = Math.max(preferredHalfWidth, Math.min(center, viewportWidth - preferredHalfWidth));
  return { left, top: rect.top - 8, placement: "above" };
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

export function tooltipIsDisabled(element: { closest: (selector: string) => unknown } | null): boolean {
  return Boolean(element?.closest(disabledTooltipRegionSelector))
    && !Boolean(element?.closest(alwaysEnabledTooltipSelector));
}

function tooltipsDisabled(element: HTMLElement | null): boolean {
  return tooltipIsDisabled(element);
}

function suppressNativeTitle(element: HTMLElement): void {
  const title = element.getAttribute("title");
  if (title === null || element.hasAttribute(savedTitleAttribute)) return;
  element.setAttribute(savedTitleAttribute, title);
  element.removeAttribute("title");
}

function restoreNativeTitle(element: HTMLElement | null): void {
  if (!element) return;
  // Keep browser-native title popups suppressed while a workspace has opted
  // out. The saved value is still available if the preference is re-enabled.
  if (tooltipsDisabled(element)) return;
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
  const tooltipElement = useRef<HTMLDivElement | null>(null);
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);

  useLayoutEffect(() => {
    if (!tooltip || !tooltipElement.current) return;
    // Keep the above placement, but prevent controls near the viewport's top
    // edge from putting the text off-screen. Measure wrapped text as well.
    const minimumTop = tooltipElement.current.getBoundingClientRect().height + 8;
    if (tooltip.top < minimumTop) {
      setTooltip((current) => current === tooltip ? { ...tooltip, top: minimumTop } : current);
    }
  }, [tooltip]);

  useEffect(() => {
    let pointerTarget: HTMLElement | null = null;
    let focusTarget: HTMLElement | null = null;

    // A route transition can unmount the element that owns a tooltip before
    // it emits pointerout/focusout (for example, the workspace back button).
    // Clear the shared overlay as soon as an interaction begins navigation so
    // it cannot remain above the next page without an anchor.
    const dismiss = () => {
      pointerTarget = null;
      focusTarget = null;
      restoreNativeTitle(active.current);
      active.current = null;
      setTooltip(null);
    };

    const updateActive = () => {
      const next = pointerTarget ?? focusTarget;
      if (next && tooltipsDisabled(next)) {
        if (next !== active.current) restoreNativeTitle(active.current);
        active.current = next;
        suppressNativeTitle(next);
        setTooltip(null);
        return;
      }
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
      if (tooltipsDisabled(element)) {
        suppressNativeTitle(element);
        setTooltip(null);
        return;
      }
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
    document.addEventListener("click", dismiss, true);
    window.addEventListener("resize", refreshPosition);
    window.addEventListener("scroll", refreshPosition, true);
    window.addEventListener("blur", dismiss);
    window.addEventListener("pagehide", dismiss);
    window.addEventListener("popstate", dismiss);
    const preferenceObserver = new MutationObserver(updateActive);
    preferenceObserver.observe(document.documentElement, {
      attributes: true,
      subtree: true,
      attributeFilter: ["data-texlite-tooltips"]
    });
    return () => {
      document.removeEventListener("pointerover", onPointerOver, true);
      document.removeEventListener("pointerout", onPointerOut, true);
      document.removeEventListener("focusin", onFocusIn, true);
      document.removeEventListener("focusout", onFocusOut, true);
      document.removeEventListener("click", dismiss, true);
      window.removeEventListener("resize", refreshPosition);
      window.removeEventListener("scroll", refreshPosition, true);
      window.removeEventListener("blur", dismiss);
      window.removeEventListener("pagehide", dismiss);
      window.removeEventListener("popstate", dismiss);
      preferenceObserver.disconnect();
      restoreNativeTitle(active.current);
      active.current = null;
    };
  }, []);

  if (!tooltip) return null;
  return <div ref={tooltipElement} id="texlite-global-tooltip" role="tooltip" className={`global-tooltip ${tooltip.placement}`} style={{ left: tooltip.left, top: tooltip.top }}>{tooltip.text}</div>;
}
