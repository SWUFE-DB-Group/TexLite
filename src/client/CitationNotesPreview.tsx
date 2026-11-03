import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import katex from "katex";
import "katex/dist/katex.min.css";
import { NotebookPen } from "lucide-react";
import { useTranslation } from "react-i18next";

const components: Components = {
  a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" />,
  code: ({ node: _node, className, children, ...props }) => {
    const classes = className?.split(/\s+/) ?? [];
    if (!classes.includes("language-math")) return <code className={className} {...props}>{children}</code>;
    // remark-math identifies the math nodes; use the application's KaTeX
    // so notes and editor previews use the same renderer and options.
    const html = katex.renderToString(String(children), {
      displayMode: !classes.includes("math-inline"), throwOnError: false,
      strict: "ignore", trust: false, maxSize: 20, maxExpand: 1000
    });
    return <span className="citation-notes-math" dangerouslySetInnerHTML={{ __html: html }} />;
  },
  pre: ({ node, children, ...props }) => {
    const math = node?.children.some((child) => child.type === "element" && child.tagName === "code"
      && Array.isArray(child.properties.className) && child.properties.className.includes("language-math"));
    return math ? <div className="citation-notes-equation">{children}</div> : <pre {...props}>{children}</pre>;
  }
};

/** Shared by the unsaved preview and saved notes. Never interpret raw HTML. */
export default function CitationNotesPreview({ notes }: { notes: string }) {
  const { t } = useTranslation();
  return notes.trim() ? <div className="citation-notes-markdown"><Markdown remarkPlugins={[remarkGfm, remarkMath]} skipHtml components={components}>{notes}</Markdown></div>
    : <div className="citation-notes-empty"><NotebookPen size={26} aria-hidden /><p>{t("citationNotes.empty")}</p></div>;
}
