import type { Extension } from "@codemirror/state";
import { hoverTooltip, type Tooltip } from "@codemirror/view";
import { findLatexMathRangeAt } from "./latexMath";

interface MathHoverLabels {
  loading: string;
  unavailable: string;
  preview: string;
}

type Katex = typeof import("katex").default;

let katexPromise: Promise<Katex> | null = null;

function loadKatex(): Promise<Katex> {
  if (!katexPromise) {
    katexPromise = Promise.all([
      import("katex"),
      import("katex/dist/katex.min.css")
    ]).then(([module]) => module.default).catch((error: unknown) => {
      katexPromise = null;
      throw error;
    });
  }
  return katexPromise;
}

function mathTooltip(source: string, from: number, to: number, displayMode: boolean, labels: MathHoverLabels): Tooltip {
  let disposed = false;
  return {
    pos: from,
    end: to,
    above: true,
    arrow: true,
    create() {
      const dom = document.createElement("div");
      dom.className = `texlite-math-hover${displayMode ? " display" : " inline"}`;
      dom.setAttribute("role", "status");
      dom.setAttribute("aria-label", labels.preview);
      dom.textContent = labels.loading;
      void loadKatex().then((katex) => {
        if (disposed) return;
        dom.replaceChildren();
        try {
          katex.render(source, dom, {
            displayMode,
            throwOnError: true,
            strict: "ignore",
            trust: false
          });
        } catch {
          dom.textContent = labels.unavailable;
          dom.classList.add("texlite-math-hover-error");
        }
      }).catch(() => {
        if (disposed) return;
        dom.textContent = labels.unavailable;
        dom.classList.add("texlite-math-hover-error");
      });
      return { dom, destroy() { disposed = true; } };
    }
  };
}

/** Create an opt-in CodeMirror hover renderer for common LaTeX math forms. */
export function latexMathHover(labels: MathHoverLabels): Extension {
  return hoverTooltip((view, position, side) => {
    const range = findLatexMathRangeAt(view.state.doc.toString(), position, side);
    if (!range || !range.source.trim() || range.source.length > 32 * 1024) return null;
    return mathTooltip(range.source, range.from, range.to, range.displayMode, labels);
  }, { hoverTime: 350, hideOnChange: true });
}
