import { Facet, StateEffect, type Text } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { findLatexReferences, type LatexReference } from "../shared/latexReferences";
import { LatexReferenceViewportCache, referenceScanWindows, visibleLatexReferences, type LatexReferenceScanner } from "./latexReferenceDecorations";

export interface ReferenceNavigationSettings {
  enabled: boolean;
  title: (reference: LatexReference) => string;
}

export const referenceNavigationSettings = Facet.define<ReferenceNavigationSettings, ReferenceNavigationSettings>({
  combine: (values) => values.at(-1) ?? { enabled: false, title: () => "" }
});

export const REFERENCE_SCAN_DELAY_MS = 120;
const refreshReferences = StateEffect.define<{ document: Text; references: readonly LatexReference[] }>();

/** One view owns its cache, deferred scan, and navigation metadata. */
export class LatexReferenceMarkPlugin {
  decorations: DecorationSet = Decoration.none;
  private references: readonly LatexReference[] = [];
  private scannedDocument: Text | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;
  private readonly cache: LatexReferenceViewportCache;

  constructor(private readonly view: EditorView, scan: LatexReferenceScanner = findLatexReferences) {
    this.cache = new LatexReferenceViewportCache(scan);
    if (view.state.facet(referenceNavigationSettings).enabled) {
      this.references = this.cache.referencesThrough(view.state.doc, this.scanEnd());
      this.scannedDocument = view.state.doc;
      this.rebuild();
    }
  }

  update(update: ViewUpdate): void {
    const enabled = update.state.facet(referenceNavigationSettings).enabled;
    const settingsChanged = update.startState.facet(referenceNavigationSettings) !== update.state.facet(referenceNavigationSettings);
    if (!enabled) {
      this.cancel();
      this.cache.clear();
      this.references = [];
      this.scannedDocument = null;
      this.decorations = Decoration.none;
      return;
    }

    if (update.docChanged) {
      // An edit may change a comment or literal boundary for the whole suffix.
      // Retain only marks before the earliest changed line, not stale clickable
      // marks inside or after it. Lezer's syntax colors remain immediate.
      let invalidFrom = update.startState.doc.length;
      update.changes.iterChangedRanges((from) => {
        invalidFrom = Math.min(invalidFrom, update.startState.doc.lineAt(from).from);
      });
      const visible = visibleLatexReferences(this.references, referenceScanWindows(update.state.doc, this.view.visibleRanges));
      this.references = visible.filter((reference) => reference.to <= invalidFrom).map((reference) => ({
        ...reference,
        from: update.changes.mapPos(reference.from, 1),
        to: update.changes.mapPos(reference.to, -1)
      }));
      this.cache.clear();
      this.scannedDocument = null;
      this.cancel();
      this.schedule();
    }

    let refreshed = false;
    for (const transaction of update.transactions) for (const effect of transaction.effects) {
      if (effect.is(refreshReferences) && effect.value.document === update.state.doc) {
        this.references = effect.value.references;
        this.scannedDocument = effect.value.document;
        refreshed = true;
      }
    }

    if (!update.docChanged && update.viewportChanged) {
      const cached = this.cache.cachedThrough(update.state.doc, this.scanEnd());
      if (cached) {
        this.references = cached;
        this.scannedDocument = update.state.doc;
      } else {
        // Reflow/scroll must not bypass the pending typing debounce.
        this.schedule();
      }
    }
    if (settingsChanged && this.scannedDocument !== update.state.doc) this.schedule();
    if (update.docChanged || update.viewportChanged || settingsChanged || refreshed) this.rebuild();
  }

  /** Revalidate rare clicks while an edit has invalidated the scan snapshot. */
  resolve(reference: LatexReference): LatexReference | null {
    if (this.destroyed || !this.view.state.facet(referenceNavigationSettings).enabled) return null;
    const references = this.scannedDocument === this.view.state.doc
      ? this.references : this.cache.referencesFor(this.view.state.doc);
    return references.find((candidate) => candidate.kind === reference.kind && candidate.key === reference.key
      && candidate.from === reference.from && candidate.to === reference.to && candidate.command === reference.command) ?? null;
  }

  destroy(): void {
    this.destroyed = true;
    this.cancel();
    this.cache.clear();
    this.references = [];
    this.scannedDocument = null;
    this.decorations = Decoration.none;
  }

  private scanEnd(): number {
    return referenceScanWindows(this.view.state.doc, this.view.visibleRanges)
      .reduce((maximum, window) => Math.max(maximum, window.to), 0);
  }

  private schedule(): void {
    if (this.timer !== null || this.destroyed) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.destroyed || !this.view.state.facet(referenceNavigationSettings).enabled) return;
      const document = this.view.state.doc;
      const references = this.cache.referencesThrough(document, this.scanEnd());
      if (this.destroyed || this.view.state.doc !== document) return;
      this.view.dispatch({ effects: refreshReferences.of({ document, references }) });
    }, REFERENCE_SCAN_DELAY_MS);
  }

  private cancel(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private rebuild(): void {
    const settings = this.view.state.facet(referenceNavigationSettings);
    const windows = referenceScanWindows(this.view.state.doc, this.view.visibleRanges);
    const visible = visibleLatexReferences(this.references, windows);
    const seen = new Set<string>();
    const marks = visible.filter((reference) => {
      const signature = `${reference.kind}:${reference.key}:${reference.from}:${reference.to}`;
      if (seen.has(signature) || reference.to <= reference.from) return false;
      seen.add(signature);
      return true;
    }).map((reference) => Decoration.mark({
      class: reference.kind === "citation" ? "cm-latex-citation-key" : "cm-latex-label-key",
      attributes: {
        title: settings.title(reference), spellcheck: "false",
        "data-latex-reference-kind": reference.kind,
        "data-latex-reference-key": reference.key,
        "data-latex-reference-from": String(reference.from),
        "data-latex-reference-to": String(reference.to),
        "data-latex-reference-command": reference.command
      }
    }).range(reference.from, reference.to));
    this.decorations = marks.length ? Decoration.set(marks, true) : Decoration.none;
  }
}

export const latexReferenceMarks = ViewPlugin.fromClass(LatexReferenceMarkPlugin, {
  decorations: (plugin) => plugin.decorations
});
