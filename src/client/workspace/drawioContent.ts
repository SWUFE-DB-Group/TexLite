const maxXmlLength = 5 * 1024 * 1024;
const fileMetadata = new Set(["host", "agent", "version", "modified", "etag"]);

function parseXml(xml: string): Element | null {
  if (xml.length > maxXmlLength || /<!DOCTYPE/i.test(xml)) return null;
  const document = new DOMParser().parseFromString(xml, "application/xml");
  return document.querySelector("parsererror") ? null : document.documentElement;
}

/** Draw.io's SVG export uses base64/deflate/URI-encoded pages even when XML
 * export and autosave use expanded XML. Bound inflation of embedded messages. */
async function expandPage(data: string): Promise<Element | null> {
  const bytes = Uint8Array.from(atob(data), (character) => character.charCodeAt(0));
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let encoded = "", length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxXmlLength * 3) return null;
      encoded += decoder.decode(value, { stream: true });
    }
    return parseXml(decodeURIComponent(encoded + decoder.decode()));
  } finally { await reader.cancel(); }
}

function contentKey(element: Element, root: Element): unknown {
  const attributes = [...element.attributes]
    .filter(({ name }) => !(element === root && root.tagName === "mxfile" && fileMetadata.has(name))
      && !(element.tagName === "mxGraphModel" && (name === "dx" || name === "dy")))
    .map(({ name, value }) => [name, value]).sort(([a], [b]) => a.localeCompare(b));
  const children = [...element.childNodes].flatMap((node): unknown[] => {
    if (node.nodeType === Node.ELEMENT_NODE) return [contentKey(node as Element, root)];
    // Ignore pretty-print indentation, not text labels or user attributes.
    if (node.nodeType === Node.TEXT_NODE && element.children.length && !node.textContent?.trim()) return [];
    return [[node.nodeType, node.nodeValue]];
  });
  return [element.tagName, attributes, children];
}

async function diagramKey(xml: string): Promise<string | null> {
  try {
    const root = parseXml(xml);
    if (!root || !["mxfile", "mxGraphModel"].includes(root.tagName)) return null;
    let expandedLength = xml.length;
    for (const page of root.tagName === "mxfile" ? [...root.children] : []) {
      if (page.tagName === "diagram" && !page.children.length && page.textContent?.trim()) {
        const model = await expandPage(page.textContent.trim());
        if (model?.tagName !== "mxGraphModel") return null;
        expandedLength += new XMLSerializer().serializeToString(model).length - page.textContent.length;
        if (expandedLength > maxXmlLength) return null;
        page.replaceChildren(model);
      }
    }
    return JSON.stringify(contentKey(root, root));
  } catch {
    // Malformed/unsupported input must never hide unsaved changes.
    return null;
  }
}

/** Compare graph content, not compression, formatting or viewport dimensions. */
export async function sameDrawioContent(first: string, second: string): Promise<boolean> {
  if (first === second) return true;
  const [a, b] = await Promise.all([diagramKey(first), diagramKey(second)]);
  return a !== null && b !== null && a === b;
}
