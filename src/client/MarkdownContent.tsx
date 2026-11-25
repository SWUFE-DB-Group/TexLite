import Markdown, { defaultUrlTransform, type Components, type UrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import katex from "katex";
import "katex/dist/katex.min.css";
import type { ReactNode } from "react";
import { CircleAlert, Info, Lightbulb, OctagonAlert, TriangleAlert } from "lucide-react";
import { useTranslation } from "react-i18next";
import { remarkMarkdownAlerts } from "./markdownAlerts";
import MarkdownMermaid from "./MarkdownMermaid";

type HastNode = { type: string; tagName?: string; properties?: Record<string, unknown>; position?: { start?: { line?: number } }; children?: HastNode[] };

const SOURCE_LINE_TAGS = new Set(["p", "h1", "h2", "h3", "h4", "h5", "h6", "li", "blockquote", "pre", "table", "tr", "hr"]);
const alertIcons = { note: Info, tip: Lightbulb, important: CircleAlert, warning: TriangleAlert, caution: OctagonAlert };
type AlertKind = keyof typeof alertIcons;

function isAlertKind(value: unknown): value is AlertKind {
  return typeof value === "string" && Object.hasOwn(alertIcons, value);
}

function MarkdownAlert({ kind, line, children }: { kind: AlertKind; line?: number; children: ReactNode }) {
  const { t } = useTranslation();
  const Icon = alertIcons[kind];
  return <div className={`markdown-alert markdown-alert-${kind}`} data-source-line={line}>
    <p className="markdown-alert-title"><Icon size={16} aria-hidden />{t(`markdownAlerts.${kind}`)}</p>
    {children}
  </div>;
}

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
  blockquote: ({ node, children, ...props }) => {
    const kind = node?.properties.dataMarkdownAlert;
    const line = node?.properties.dataSourceLine;
    return isAlertKind(kind) ? <MarkdownAlert kind={kind} line={typeof line === "number" ? line : undefined}>{children}</MarkdownAlert>
      : <blockquote {...props}>{children}</blockquote>;
  },
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
    const code = node?.children.find((child) => child.type === "element" && child.tagName === "code");
    const { "data-source-line": line, ...preProps } = props as typeof props & { "data-source-line"?: number };
    if (code?.type === "element" && Array.isArray(code.properties.className)) {
      const classes = code.properties.className;
      if (classes.includes("language-math")) return <div className="markdown-equation" data-source-line={line}>{children}</div>;
      if (classes.includes("language-mermaid")) {
        const source = code.children.map((child) => child.type === "text" ? child.value : "").join("");
        return <MarkdownMermaid source={source} line={line} fallback={<pre {...preProps}>{children}</pre>} />;
      }
    }
    return <pre {...props}>{children}</pre>;
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
 * GitHub-flavoured Markdown with KaTeX math and Mermaid diagrams. Authored HTML is never interpreted,
 * and URLs go through react-markdown's safe-protocol filter first.
 */
export default function MarkdownContent({ source, className, components, urlTransform, sourceLines = false }: MarkdownContentProps) {
  return <div className={`markdown-content ${className}`}>
    <Markdown remarkPlugins={[remarkGfm, remarkMath, remarkMarkdownAlerts]} rehypePlugins={sourceLines ? [rehypeSourceLines] : []} skipHtml
      components={components ? { ...baseComponents, ...components } : baseComponents}
      urlTransform={(url, key, node) => {
        const safe = defaultUrlTransform(url);
        return safe && urlTransform ? urlTransform(safe, key, node) : safe;
      }}>{source}</Markdown>
  </div>;
}
