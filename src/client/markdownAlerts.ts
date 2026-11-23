import type { Root } from "mdast";
import type { VFile } from "vfile";

const alertMarker = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*(?:\r\n?|\n|$)/;

/** GitHub-style alerts are top-level quotes whose first line is a plain marker. */
export function remarkMarkdownAlerts() {
  return (tree: Root, file: VFile) => {
    const source = String(file);
    for (const quote of tree.children) {
      if (quote.type !== "blockquote") continue;
      const paragraph = quote.children[0];
      if (paragraph?.type !== "paragraph") continue;
      const first = paragraph.children[0];
      const start = first?.position?.start;
      if (first?.type !== "text" || start?.offset === undefined) continue;

      // Check the authored text as well so an escaped or entity-encoded marker
      // remains a literal quote after Markdown decoding.
      const marker = alertMarker.exec(first.value);
      const authored = marker && alertMarker.exec(source.slice(start.offset));
      if (!marker || !authored || authored[1] !== marker[1]) continue;
      quote.data = { ...quote.data, hProperties: { ...quote.data?.hProperties, dataMarkdownAlert: marker[1].toLowerCase() } };

      const remainder = first.value.slice(marker[0].length);
      if (remainder) {
        first.value = remainder;
        const nextLineOffset = start.offset + authored[0].length;
        const quotePrefix = /^ {0,3}>[ \t]?/.exec(source.slice(nextLineOffset))?.[0].length ?? 0;
        const bodyStart = { line: start.line + 1, column: quotePrefix + 1, offset: nextLineOffset + quotePrefix };
        if (first.position) first.position.start = bodyStart;
      } else {
        paragraph.children.shift();
        if (paragraph.children[0]?.type === "break") paragraph.children.shift();
      }
      if (paragraph.children.length === 0) quote.children.shift();
      else if (paragraph.position && paragraph.children[0].position) paragraph.position.start = paragraph.children[0].position.start;
    }
  };
}
