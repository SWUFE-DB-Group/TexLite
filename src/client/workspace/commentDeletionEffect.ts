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

  return () => {
    // Do not leave particles in another project or ignore a changed motion preference.
    if (!owner.isConnected || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const layer = document.createElement("div");
    layer.className = "comment-paper-shred";
    layer.setAttribute("aria-hidden", "true");
    layer.inert = true;
    Object.assign(layer.style, { left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px` });
    // A small, fixed number of neutral paper fragments; never clone comment text or controls.
    for (let index = 0; index < 24; index++) {
      const piece = document.createElement("span");
      const column = index % 6;
      piece.style.left = `${(column + .5) / 6 * 100}%`;
      piece.style.top = `${(Math.floor(index / 6) + .5) / 4 * 100}%`;
      piece.style.width = `${6 + index * 7 % 9}px`;
      piece.style.height = `${8 + index * 11 % 13}px`;
      piece.style.setProperty("--shred-x", `${(column - 2.5) * 9}px`);
      piece.style.setProperty("--shred-y", `${28 + index * 13 % 45}px`);
      piece.style.setProperty("--shred-angle", `${index * 37 % 80 - 40}deg`);
      piece.style.animationDelay = `${index % 4 * 12}ms`;
      layer.append(piece);
    }
    const remove = () => { window.clearTimeout(timer); layer.remove(); };
    // Fallback also cleans up when animation events are interrupted or unavailable.
    const timer = window.setTimeout(remove, 650);
    layer.addEventListener("animationend", (event) => { if (event.target === layer) remove(); });
    document.body.append(layer);
  };
}
