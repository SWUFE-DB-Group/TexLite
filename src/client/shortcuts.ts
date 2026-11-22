export function isApplePlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  const platform = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform
    || navigator.platform
    || navigator.userAgent
    || "";
  return /mac|iphone|ipad|ipod/i.test(platform);
}

/** Format a single primary-modifier shortcut (e.g. "S" -> "⌘S" or "Ctrl+S"). */
export function formatShortcutKey(key: string): string {
  return isApplePlatform() ? `⌘${key}` : `Ctrl+${key}`;
}
