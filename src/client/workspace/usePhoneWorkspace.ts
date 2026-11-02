import { useEffect, useSyncExternalStore } from "react";

export const PHONE_WORKSPACE_QUERY = "(max-width: 600px)";
const matches = () => typeof window.matchMedia === "function" && window.matchMedia(PHONE_WORKSPACE_QUERY).matches;
const subscribe = (notify: () => void) => {
  const query = window.matchMedia?.(PHONE_WORKSPACE_QUERY);
  query?.addEventListener("change", notify);
  return () => query?.removeEventListener("change", notify);
};

export function usePhoneWorkspace(): boolean {
  return useSyncExternalStore(subscribe, matches, () => false);
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
