/** Support both secure contexts and trusted HTTP/LAN deployments. */
export async function copyTextToClipboard(text: string, container: () => HTMLElement | null): Promise<void> {
  try {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return; }
  } catch { /* A denied Clipboard API may still allow a user-initiated copy. */ }
  const parent = container();
  if (!parent?.isConnected || typeof document.execCommand !== "function") throw new Error("Clipboard unavailable");
  const active = document.activeElement;
  const selection = window.getSelection();
  const ranges = selection ? Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index).cloneRange()) : [];
  const input = document.createElement("textarea");
  input.value = text;
  input.readOnly = true;
  input.tabIndex = -1;
  input.setAttribute("aria-hidden", "true");
  input.style.cssText = "position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none";
  // Keep fallback focus inside the caller (and any containing dialog).
  parent.append(input);
  try {
    input.focus({ preventScroll: true }); input.select();
    if (!document.execCommand("copy")) throw new Error("Copy rejected");
  } finally {
    input.remove();
    if (active instanceof HTMLElement && active.isConnected) active.focus({ preventScroll: true });
    if (selection) { selection.removeAllRanges(); for (const range of ranges) selection.addRange(range); }
  }
}
