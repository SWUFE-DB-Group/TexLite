export interface SourceCursor {
  readonly line: number;
  readonly column: number;
  readonly offset: number;
}

export interface SourceCursorStore {
  /** The precise position used by source-to-PDF actions. */
  getCursor: () => SourceCursor;
  /** The only cursor value the React outline needs to render. */
  getOutlineLine: () => number;
  subscribe: (listener: () => void) => () => void;
  update: (line: number, column: number, offset: number) => void;
  reset: () => void;
  dispose: () => void;
}

function scheduleFrame(callback: () => void): () => void {
  if (typeof globalThis.requestAnimationFrame === "function") {
    const frame = globalThis.requestAnimationFrame(callback);
    return () => globalThis.cancelAnimationFrame(frame);
  }
  const timer = globalThis.setTimeout(callback, 0);
  return () => globalThis.clearTimeout(timer);
}

/**
 * Keep high-frequency cursor movement outside the workspace controller's
 * React state. The precise position is available immediately, while only a
 * changed outline line notifies React on the next animation frame.
 */
export function createSourceCursorStore(): SourceCursorStore {
  let cursor: SourceCursor = { line: 1, column: 1, offset: 0 };
  let outlineLine = cursor.line;
  let pendingOutlineLine: number | null = null;
  let cancelPendingFrame: (() => void) | null = null;
  const listeners = new Set<() => void>();

  const notify = (): void => {
    for (const listener of listeners) listener();
  };

  const flushOutlineLine = (): void => {
    cancelPendingFrame = null;
    const nextLine = pendingOutlineLine;
    pendingOutlineLine = null;
    if (nextLine === null || nextLine === outlineLine) return;
    outlineLine = nextLine;
    notify();
  };

  const scheduleOutlineLine = (line: number): void => {
    pendingOutlineLine = line;
    if (cancelPendingFrame !== null) return;
    cancelPendingFrame = scheduleFrame(flushOutlineLine);
  };

  return {
    getCursor: () => cursor,
    getOutlineLine: () => outlineLine,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    update: (line, column, offset) => {
      if (cursor.line === line && cursor.column === column && cursor.offset === offset) return;
      cursor = { line, column, offset };
      // A cursor can cross a line and return before the next frame. Refresh an
      // already-pending target even when the final line equals the published
      // one, otherwise the intermediate line would be highlighted.
      if (line !== outlineLine || cancelPendingFrame !== null) scheduleOutlineLine(line);
    },
    reset: () => {
      cancelPendingFrame?.();
      cancelPendingFrame = null;
      pendingOutlineLine = null;
      cursor = { line: 1, column: 1, offset: 0 };
      if (outlineLine === 1) return;
      outlineLine = 1;
      notify();
    },
    dispose: () => {
      cancelPendingFrame?.();
      cancelPendingFrame = null;
      pendingOutlineLine = null;
    }
  };
}
