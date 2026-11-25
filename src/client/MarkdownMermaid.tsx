import { useEffect, useId, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

const diagramLimits = { limit: 20_000, maxEdges: 500, outputLimit: 1_000_000 };

export default function MarkdownMermaid({ source, line, fallback }: {
  source: string;
  line?: number;
  fallback: ReactNode;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [result, setResult] = useState<{ source: string; diagram: { svg: string; width: number } | null }>();
  const current = result?.source === source ? result : undefined;
  const tooLarge = source.length > diagramLimits.limit;

  useEffect(() => {
    if (tooLarge) return;
    let cancelled = false;
    void import("pele/lazy").then(({ renderAsync }) => {
      if (cancelled) return;
      // Do not supply link handlers, icons or raw math markup for user-authored diagrams.
      return renderAsync(source, {
        ...diagramLimits, idPrefix: `texlite-mermaid-${id.replace(/[^a-zA-Z0-9_-]/g, "-")}`,
        links: false, images: false
      });
    }).then((diagram) => {
      if (!cancelled && diagram) setResult({ source, diagram });
    }).catch(() => {
      if (!cancelled) setResult({ source, diagram: null });
    });
    return () => { cancelled = true; };
  }, [id, source, tooLarge]);

  return <div className="markdown-mermaid" data-source-line={line}>
    {current?.diagram ? <div className="markdown-mermaid-diagram" style={{ minWidth: Math.ceil(current.diagram.width * 0.75) }}
      dangerouslySetInnerHTML={{ __html: current.diagram.svg }} /> : <>
      {(tooLarge || current?.diagram === null) && <p className="markdown-mermaid-error" role="status">{t("markdownMermaid.renderFailed")}</p>}
      {fallback}
    </>}
  </div>;
}
