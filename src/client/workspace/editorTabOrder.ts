/** A tab's position in the strip's scrollable content, before any drag offset. */
export interface TabSlot { left: number; width: number }

export function moveTab(tabs: string[], path: string, to: number): string[] {
  const from = tabs.indexOf(path);
  if (from < 0 || from === to) return tabs;
  const next = tabs.filter((tab) => tab !== path);
  next.splice(Math.max(0, Math.min(to, next.length)), 0, path);
  return next;
}

/** Keep the dragged tab within the strip, as a browser does. */
export function clampTabDrag(slots: TabSlot[], from: number, offset: number): number {
  const last = slots[slots.length - 1];
  return Math.max(slots[0].left - slots[from].left,
    Math.min(last.left + last.width - slots[from].left - slots[from].width, offset));
}

/**
 * A tab takes a neighbor's place once its leading edge passes that neighbor's
 * middle. Using resting positions keeps tabs of different widths from flipping
 * back and forth as they shift.
 */
export function tabDropIndex(slots: TabSlot[], from: number, offset: number): number {
  const dragged = slots[from];
  const middle = (slot: TabSlot) => slot.left + slot.width / 2;
  let to = from;
  for (let index = from + 1; index < slots.length && dragged.left + dragged.width + offset > middle(slots[index]); index++) to = index;
  for (let index = from - 1; index >= 0 && dragged.left + offset < middle(slots[index]); index--) to = index;
  return to;
}

/** How far another tab moves to make room while one is dragged from `from` to `to`. */
export function tabShift(slots: TabSlot[], from: number, to: number, index: number): number {
  const gap = slots.length > 1 ? slots[1].left - slots[0].left - slots[0].width : 0;
  const room = slots[from].width + gap;
  if (from < index && index <= to) return -room;
  if (to <= index && index < from) return room;
  return 0;
}
