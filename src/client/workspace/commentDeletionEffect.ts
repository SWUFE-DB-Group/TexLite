export const COMMENT_SHRED_DURATION_MS = 1100;

/** Capture geometry before a successful delete removes the React-owned element. */
export function prepareCommentDeletionEffect(element: HTMLElement | null): () => void {
  const noEffect = () => {};
  if (!element || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return noEffect;
  const owner = element.closest(".comments") ?? element.parentElement;
  const rect = element.getBoundingClientRect();
  const panel = element.closest(".context-panel")?.getBoundingClientRect();
  const left = Math.max(0, rect.left, panel?.left ?? 0);
  const top = Math.max(0, rect.top, panel?.top ?? 0);
  const width = Math.min(window.innerWidth, rect.right, panel?.right ?? window.innerWidth) - left;
  const height = Math.min(180, Math.min(window.innerHeight, rect.bottom, panel?.bottom ?? window.innerHeight) - top);
  if (!owner || width <= 0 || height <= 0) return noEffect;
  let played = false;

  return () => {
    // Do not leave particles in another project or ignore a changed motion preference.
    if (played || !owner.isConnected || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    played = true;
    const layer = document.createElement("div");
    layer.className = "comment-paper-shred";
    layer.setAttribute("aria-hidden", "true");
    layer.inert = true;
    Object.assign(layer.style, { left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px` });
    layer.style.setProperty("--shred-duration", `${COMMENT_SHRED_DURATION_MS}ms`);
    layer.style.setProperty("--shred-height", `${height}px`);
    // Tessellated strips suggest the original paper shape before peeling away.
    // Short replies use one row; even a large comment needs at most 24 pieces.
    // Never copy private text, avatars or interactive controls into the effect.
    const columns = Math.min(12, Math.max(8, Math.round(width / 22)));
    const rows = height < 96 ? 1 : 2;
    for (let index = 0; index < columns * rows; index++) {
      const piece = document.createElement("span");
      const column = index % columns, row = Math.floor(index / columns);
      const spread = column / (columns - 1) * 2 - 1;
      const variation = index * 37;
      piece.style.left = `${column / columns * 100}%`;
      piece.style.top = `${row / rows * 100}%`;
      piece.style.width = `${100 / columns}%`;
      piece.style.height = `${height / rows}px`;
      piece.style.setProperty("--shred-x", `${spread * 14 + variation % 7 - 3}px`);
      piece.style.setProperty("--shred-y", `${48 + row * 16 + variation % 31}px`);
      piece.style.setProperty("--shred-angle", `${spread * 12 + variation % 13 - 6}deg`);
      piece.style.setProperty("--shred-flip", `${(index % 2 ? 1 : -1) * (18 + variation % 23)}deg`);
      piece.style.setProperty("--shred-line-offset", `${-row * height / rows}px`);
      piece.style.animationDuration = `${780 + variation % 4 * 25}ms`;
      piece.style.animationDelay = `${80 + column * 7 + row * 35 + variation % 3 * 9}ms`;
      layer.append(piece);
    }
    const remove = () => {
      window.clearTimeout(timer);
      observer.disconnect();
      window.removeEventListener("resize", remove);
      layer.remove();
    };
    const observer = new MutationObserver(() => { if (!owner.isConnected) remove(); });
    // Fallback also cleans up when animation events are interrupted or unavailable.
    const timer = window.setTimeout(remove, COMMENT_SHRED_DURATION_MS + 200);
    layer.addEventListener("animationend", (event) => {
      // Fold/cut pseudo-elements and individual strips finish before the layer.
      if (event.target === layer && !event.pseudoElement) remove();
    });
    window.addEventListener("resize", remove);
    observer.observe(document.body, { childList: true, subtree: true });
    document.body.append(layer);
  };
}
