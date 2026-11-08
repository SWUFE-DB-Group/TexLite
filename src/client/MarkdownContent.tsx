import Markdown, { defaultUrlTransform, type Components, type UrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import katex from "katex";
import "katex/dist/katex.min.css";

type HastNode = { type: string; tagName?: string; properties?: Record<string, unknown>; position?: { start?: { line?: number } }; children?: HastNode[] };

const SOURCE_LINE_TAGS = new Set(["p", "h1", "h2", "h3", "h4", "h5", "h6", "li", "blockquote", "pre", "table", "tr", "hr"]);

/** Record each block's first source line so a preview can be aligned with its editor. */
function rehypeSourceLines() {
  const visit = (node: HastNode) => {
    const line = node.position?.start?.line;
    if (node.type === "element" && node.tagName && SOURCE_LINE_TAGS.has(node.tagName) && line) {
      node.properties = { ...node.properties, dataSourceLine: line };
    }
    node.children?.forEach(visit);
  };
  return (tree: HastNode) => visit(tree);
}

const baseComponents: Components = {
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
    return <span className="markdown-math" dangerouslySetInnerHTML={{ __html: html }} />;
  },
  pre: ({ node, children, ...props }) => {
    const math = node?.children.some((child) => child.type === "element" && child.tagName === "code"
      && Array.isArray(child.properties.className) && child.properties.className.includes("language-math"));
    const line = (props as Record<string, unknown>)["data-source-line"] as number | undefined;
    return math ? <div className="markdown-equation" data-source-line={line}>{children}</div> : <pre {...props}>{children}</pre>;
  }
};

export interface MarkdownContentProps {
  source: string;
  className: string;
  /** Replace the default rendering of some elements, e.g. links inside a project. */
  components?: Components;
  urlTransform?: UrlTransform;
  /** Mark blocks with `data-source-line` for source/preview alignment. */
  sourceLines?: boolean;
}

/**
 * GitHub-flavoured Markdown with KaTeX math. Raw HTML is never interpreted,
 * and URLs go through react-markdown's safe-protocol filter first.
 */
export default function MarkdownContent({ source, className, components, urlTransform, sourceLines = false }: MarkdownContentProps) {
  return <div className={`markdown-content ${className}`}>
    <Markdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={sourceLines ? [rehypeSourceLines] : []} skipHtml
      components={components ? { ...baseComponents, ...components } : baseComponents}
      urlTransform={(url, key, node) => {
        const safe = defaultUrlTransform(url);
        return safe && urlTransform ? urlTransform(safe, key, node) : safe;
      }}>{source}</Markdown>
  </div>;
}
