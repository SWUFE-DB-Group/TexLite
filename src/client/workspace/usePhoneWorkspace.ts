import { useEffect, useSyncExternalStore } from "react";

export const PHONE_WORKSPACE_QUERY = "(max-width: 600px)";
export const COARSE_POINTER_QUERY = "(pointer: coarse), (hover: none)";
const matchesPhone = () => typeof window.matchMedia === "function" && window.matchMedia(PHONE_WORKSPACE_QUERY).matches;
const subscribePhone = (notify: () => void) => {
  const query = window.matchMedia?.(PHONE_WORKSPACE_QUERY);
  query?.addEventListener("change", notify);
  return () => query?.removeEventListener("change", notify);
};
const matchesCoarsePointer = () => typeof window.matchMedia === "function" && window.matchMedia(COARSE_POINTER_QUERY).matches;
const subscribeCoarsePointer = (notify: () => void) => {
  const query = window.matchMedia?.(COARSE_POINTER_QUERY);
  query?.addEventListener("change", notify);
  return () => query?.removeEventListener("change", notify);
};

export function usePhoneWorkspace(): boolean {
  return useSyncExternalStore(subscribePhone, matchesPhone, () => false);
}

/** Touch-first viewports (such as iPad) cannot rely on hover tooltips to identify icon-only controls. */
export function useCoarsePointer(): boolean {
  return useSyncExternalStore(subscribeCoarsePointer, matchesCoarsePointer, () => false);
}

/** Safari's keyboard changes the visual viewport without resizing the page. */
export function usePhoneWorkspaceHeight(phone: boolean): void {
  useEffect(() => {
    if (!phone) return;
    const root = document.documentElement;
    const viewport = window.visualViewport;
    const update = () => root.style.setProperty("--workspace-height", `${viewport?.height ?? window.innerHeight}px`);
    update();
    viewport?.addEventListener("resize", update);
    window.addEventListener("resize", update);
    return () => {
      viewport?.removeEventListener("resize", update);
      window.removeEventListener("resize", update);
      root.style.removeProperty("--workspace-height");
    };
  }, [phone]);
}
