import { useDeferredValue, useEffect, useImperativeHandle, useMemo, useRef, type MouseEvent, type Ref } from "react";
import type { Components } from "react-markdown";
import { FileText } from "lucide-react";
import { useTranslation } from "react-i18next";
import MarkdownContent from "../MarkdownContent";
import { headingSlugs, resolveMarkdownTarget } from "./markdownPreview";
import { rawFileUrl } from "./useProjectFiles";

export interface MarkdownPreviewHandle {
  /** First source line of the block at the top of the visible preview. */
  visibleLine(): number | null;
}

export interface MarkdownPreviewProps {
  ref?: Ref<MarkdownPreviewHandle>;
  projectId: string;
  path: string;
  source: string;
  /** Scroll to the block for a source line; a new nonce repeats the request. */
  reveal?: { line: number; nonce: number } | null;
  /** Open a project file linked from the document. */
  onOpenPath: (path: string) => void;
  /** Show a source line in the editor (double-click on a block). */
  onJumpToLine: (line: number) => void;
}

function lineOf(element: Element): number {
  return Number(element.getAttribute("data-source-line"));
}

/** Rendered Markdown of the active file, kept in step with the live source. */
export default function MarkdownPreview({ ref, projectId, path, source, reveal = null, onOpenPath, onJumpToLine }: MarkdownPreviewProps) {
  const { t } = useTranslation();
  const scroller = useRef<HTMLDivElement>(null);
  // Typing re-renders the preview at low priority so the editor stays responsive.
  const deferredSource = useDeferredValue(source);
  const callbacks = useRef({ onOpenPath, onJumpToLine });
  callbacks.current = { onOpenPath, onJumpToLine };

  useImperativeHandle(ref, () => ({
    visibleLine() {
      const container = scroller.current;
      if (!container) return null;
      const top = container.getBoundingClientRect().top + 4;
      let line: number | null = null;
      for (const block of container.querySelectorAll("[data-source-line]")) {
        if (line !== null && block.getBoundingClientRect().top > top) break;
        line = lineOf(block);
      }
      return line;
    }
  }), []);

  useEffect(() => {
    const container = scroller.current;
    if (!reveal || !container) return;
    let target: Element | null = null;
    for (const block of container.querySelectorAll("[data-source-line]")) {
      if (lineOf(block) > reveal.line) break;
      target = block;
    }
    if (!target) return;
    container.scrollTop += target.getBoundingClientRect().top - container.getBoundingClientRect().top - 16;
    target.classList.remove("markdown-source-target");
    // Restart the highlight when the same block is revealed again.
    void (target as HTMLElement).offsetWidth;
    target.classList.add("markdown-source-target");
    const timer = window.setTimeout(() => target.classList.remove("markdown-source-target"), 1600);
    return () => window.clearTimeout(timer);
  }, [reveal?.nonce]);

  const components = useMemo<Components>(() => ({
    a: ({ node: _node, href = "", children, ...props }) => {
      const target = resolveMarkdownTarget(path, href);
      if (target.kind === "external") return <a {...props} href={href} target="_blank" rel="noopener noreferrer">{children}</a>;
      if (target.kind === "anchor") {
        return <a {...props} href={href} onClick={(event) => {
          event.preventDefault();
          const headings = [...(scroller.current?.querySelectorAll("h1, h2, h3, h4, h5, h6") ?? [])];
          const index = headingSlugs(headings.map((heading) => heading.textContent ?? "")).indexOf(target.id.toLowerCase());
          const heading = headings[index];
          if (heading && scroller.current) scroller.current.scrollTop += heading.getBoundingClientRect().top - scroller.current.getBoundingClientRect().top - 16;
        }}>{children}</a>;
      }
      if (target.kind === "invalid") return <a {...props}>{children}</a>;
      // Opening in a new tab or copying the link still gives the file itself.
      return <a {...props} href={rawFileUrl(projectId, target.path)} onClick={(event) => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        callbacks.current.onOpenPath(target.path);
      }}>{children}</a>;
    }
  }), [path, projectId]);

  const rendered = useMemo(() => deferredSource.trim()
    ? <MarkdownContent className="workspace-markdown" source={deferredSource} sourceLines components={components}
      urlTransform={(url, key) => {
        if (key !== "src") return url;
        const target = resolveMarkdownTarget(path, url);
        return target.kind === "external" ? url : target.kind === "project" ? rawFileUrl(projectId, target.path) : "";
      }} />
    : <div className="preview-empty markdown-preview-empty" role="status"><FileText size={28} aria-hidden /><span>{t("editor.markdown.empty")}</span></div>,
  [components, deferredSource, path, projectId, t]);

  const jumpFromBlock = (event: MouseEvent<HTMLDivElement>) => {
    const block = (event.target as Element).closest("[data-source-line]");
    if (block) callbacks.current.onJumpToLine(lineOf(block));
  };

  return <div ref={scroller} className="markdown-preview" role="region" tabIndex={0} aria-label={t("editor.markdown.tabTitle", { path })} onDoubleClick={jumpFromBlock}>
    {rendered}
  </div>;
}
