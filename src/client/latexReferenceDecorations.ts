import type { Text } from "@codemirror/state";
import { findLatexReferences, type LatexReference } from "../shared/latexReferences";

export interface ReferenceScanWindow {
  from: number;
  to: number;
}

export type LatexReferenceScanner = (source: string) => LatexReference[];

/**
 * Cache a complete reference scan for one immutable CodeMirror document.
 *
 * The cache deliberately has one owner (the view plugin) and replaces its
 * entry whenever the document identity changes. This keeps memory bounded and
 * lets a full scan preserve literal-environment context across every viewport.
 */
export class LatexReferenceViewportCache {
  private document: Text | null = null;
  private references: readonly LatexReference[] = [];
  private scannedTo = -1;

  constructor(private readonly scan: LatexReferenceScanner = findLatexReferences) {}

  referencesFor(document: Text): readonly LatexReference[] {
    return this.referencesThrough(document, document.length);
  }

  /** Scan only the prefix needed for a viewport, extending coverage as needed. */
  referencesThrough(document: Text, to: number): readonly LatexReference[] {
    to = Math.max(0, Math.min(to, document.length));
    if (document !== this.document) {
      this.document = document;
      this.references = [];
      this.scannedTo = -1;
    }
    if (to > this.scannedTo) {
      const references = this.scan(document.sliceString(0, to));
      this.references = references;
      this.scannedTo = to;
    }
    return this.references;
  }

  cachedThrough(document: Text, to: number): readonly LatexReference[] | null {
    return document === this.document && to <= this.scannedTo ? this.references : null;
  }

  referencesIn(document: Text, windows: readonly ReferenceScanWindow[]): LatexReference[] {
    return visibleLatexReferences(this.referencesFor(document), windows);
  }

  clear(): void {
    this.document = null;
    this.references = [];
    this.scannedTo = -1;
  }
}

/**
 * Expand visible viewport ranges to complete lines with a small context
 * margin. This avoids flicker while CodeMirror lays out wrapped lines.
 */
export function referenceScanWindows(
  document: Text,
  visibleRanges: readonly ReferenceScanWindow[],
  context = 1_024
): ReferenceScanWindow[] {
  if (document.length === 0) return [];
  const raw = (visibleRanges.length ? visibleRanges : [{ from: 0, to: document.length }])
    .map((range) => {
      const fromOffset = Math.max(0, range.from - context);
      const toOffset = Math.min(document.length, range.to + context);
      const from = document.lineAt(fromOffset).from;
      const lastOffset = Math.max(fromOffset, Math.max(0, toOffset - 1));
      const to = document.lineAt(lastOffset).to;
      return { from, to };
    })
    .sort((left, right) => left.from - right.from);
  const merged: ReferenceScanWindow[] = [];
  for (const range of raw) {
    const previous = merged.at(-1);
    if (previous && range.from <= previous.to) previous.to = Math.max(previous.to, range.to);
    else merged.push(range);
  }
  return merged;
}

/**
 * Return only references wholly contained in a viewport window. References
 * are source-ordered, so each window starts from a binary-search boundary
 * rather than testing every document reference for every scroll event.
 */
export function visibleLatexReferences(
  references: readonly LatexReference[],
  windows: readonly ReferenceScanWindow[]
): LatexReference[] {
  if (references.length === 0 || windows.length === 0) return [];
  const visible: LatexReference[] = [];

  for (const window of windows) {
    for (let index = firstReferenceAtOrAfter(references, window.from); index < references.length; index += 1) {
      const reference = references[index];
      if (reference.from >= window.to) break;
      if (reference.to <= window.to) visible.push(reference);
    }
  }
  return visible;
}

function firstReferenceAtOrAfter(references: readonly LatexReference[], from: number): number {
  let low = 0;
  let high = references.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (references[middle].from < from) low = middle + 1;
    else high = middle;
  }
  return low;
}
