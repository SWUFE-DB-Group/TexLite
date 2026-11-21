import { cloneElement, useEffect, useId, useLayoutEffect, useRef, useState, type ReactElement, type ReactNode } from "react";

type TooltipPlacement = "above" | "below";

interface TooltipState {
  seq: number;
  text: string;
  content?: ReactNode;
  left: number;
  top: number;
  placement: TooltipPlacement;
  instant: boolean;
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
const richTooltipContents = new Map<string, ReactNode>();
const richContentChanged = "texlite:tooltip-content-changed";
const HOVER_INTENT_DELAY_MS = 340;
const WARM_TRANSITION_WINDOW_MS = 320;

/** Structured React content shares ordinary tooltip positioning and dismissal. */
export function RichTooltip({ children, text, content }: {
  children: ReactElement<Record<string, unknown>>;
  text: string;
  content: ReactNode;
}) {
  const id = useId();
  useLayoutEffect(() => {
    richTooltipContents.set(id, content);
    document.dispatchEvent(new CustomEvent(richContentChanged, { detail: id }));
  }, [id, content]);
  useLayoutEffect(() => () => {
    richTooltipContents.delete(id);
    document.dispatchEvent(new CustomEvent(richContentChanged, { detail: id }));
  }, [id]);
  return cloneElement(children, { "data-tooltip": text, "data-tooltip-content": id });
}

function tooltipContent(element: HTMLElement): ReactNode {
  return richTooltipContents.get(element.getAttribute("data-tooltip-content") ?? "");
}

export function globalTooltipPosition(
  rect: TooltipRect,
  viewportWidth: number,
  tooltipWidth = 0,
  tooltipHeight = 0,
  viewportHeight = 0
): Pick<TooltipState, "left" | "top" | "placement"> {
  const halfWidth = Math.min(tooltipWidth, Math.max(0, viewportWidth - 16)) / 2;
  const center = rect.left + rect.width / 2;
  const left = Math.max(halfWidth + 8, Math.min(center, viewportWidth - halfWidth - 8));
  const aboveTop = rect.top - 8;
  if (tooltipHeight > 0 && aboveTop < tooltipHeight + 8) {
    const belowTop = rect.bottom + 8;
    const spaceAbove = rect.top - 8;
    const spaceBelow = viewportHeight > 0 ? viewportHeight - rect.bottom - 8 : tooltipHeight + 8;
    if (spaceBelow >= tooltipHeight + 8 || spaceBelow > spaceAbove) {
      return { left, top: belowTop, placement: "below" };
    }
    return { left, top: Math.max(aboveTop, tooltipHeight + 8), placement: "above" };
  }
  return { left, top: aboveTop, placement: "above" };
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
  const seqRef = useRef(0);
  const openedAtRef = useRef(0);
  const wasInstantRef = useRef(false);
  const warmUntilRef = useRef(0);
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);

  useLayoutEffect(() => {
    if (!tooltip || !tooltipElement.current || !active.current) return;
    // Measure wrapped text and flip below controls near the viewport top edge
    // so topbar tooltips never cover their own trigger.
    const measured = tooltipElement.current.getBoundingClientRect();
    const position = globalTooltipPosition(
      active.current.getBoundingClientRect(),
      window.innerWidth,
      measured.width,
      measured.height,
      window.innerHeight
    );
    if (tooltip.left !== position.left || tooltip.top !== position.top || tooltip.placement !== position.placement) {
      setTooltip((current) => current === tooltip ? { ...tooltip, ...position } : current);
    }
  }, [tooltip]);

  useEffect(() => {
    let pointerTarget: HTMLElement | null = null;
    let focusTarget: HTMLElement | null = null;

    const recordWarmWindow = () => {
      if (!active.current) return;
      const now = Date.now();
      if (wasInstantRef.current || now - openedAtRef.current >= HOVER_INTENT_DELAY_MS) {
        warmUntilRef.current = now + WARM_TRANSITION_WINDOW_MS;
      }
    };

    // A route transition can unmount the element that owns a tooltip before
    // it emits pointerout/focusout (for example, the workspace back button).
    // Clear the shared overlay as soon as an interaction begins navigation so
    // it cannot remain above the next page without an anchor.
    const dismiss = () => {
      pointerTarget = null;
      focusTarget = null;
      restoreNativeTitle(active.current);
      active.current = null;
      openedAtRef.current = 0;
      wasInstantRef.current = false;
      warmUntilRef.current = 0;
      setTooltip(null);
    };

    const updateActive = () => {
      const next = pointerTarget ?? focusTarget;
      const fromKeyboard = !pointerTarget && Boolean(focusTarget);
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
        const position = globalTooltipPosition(next.getBoundingClientRect(), window.innerWidth);
        setTooltip((current) => ({
          seq: current?.seq ?? ++seqRef.current,
          text,
          content: tooltipContent(next),
          ...position,
          instant: current?.instant ?? true
        }));
        return;
      }
      recordWarmWindow();
      restoreNativeTitle(active.current);
      active.current = next;
      if (!next) {
        openedAtRef.current = 0;
        wasInstantRef.current = false;
        setTooltip(null);
        return;
      }
      const text = tooltipText(next);
      if (!text) {
        openedAtRef.current = 0;
        wasInstantRef.current = false;
        setTooltip(null);
        return;
      }
      suppressNativeTitle(next);
      const now = Date.now();
      const instant = fromKeyboard || now <= warmUntilRef.current;
      openedAtRef.current = now;
      wasInstantRef.current = instant;
      const seq = ++seqRef.current;
      setTooltip({
        seq,
        text,
        content: tooltipContent(next),
        ...globalTooltipPosition(next.getBoundingClientRect(), window.innerWidth),
        instant
      });
    };

    const refreshPosition = () => {
      const element = active.current;
      if (!element) return;
      if (!element.isConnected) { dismiss(); return; }
      if (tooltipsDisabled(element)) {
        suppressNativeTitle(element);
        setTooltip(null);
        return;
      }
      const text = tooltipText(element);
      if (!text) return;
      const position = globalTooltipPosition(element.getBoundingClientRect(), window.innerWidth);
      setTooltip((current) => current ? {
        ...current,
        text,
        content: tooltipContent(element),
        ...position
      } : {
        seq: ++seqRef.current,
        text,
        content: tooltipContent(element),
        ...position,
        instant: true
      });
    };
    const refreshContent = (event: Event) => {
      const id = (event as CustomEvent<string>).detail;
      if (active.current?.getAttribute("data-tooltip-content") !== id) return;
      if (richTooltipContents.has(id)) refreshPosition();
      else dismiss();
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
    document.addEventListener(richContentChanged, refreshContent);
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
      document.removeEventListener(richContentChanged, refreshContent);
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
  return <div key={tooltip.seq} ref={tooltipElement} id="texlite-global-tooltip" role="tooltip" data-instant={tooltip.instant ? "true" : undefined} className={`global-tooltip ${tooltip.placement}`} style={{ left: tooltip.left, top: tooltip.top }}>{tooltip.content ?? tooltip.text}</div>;
}
