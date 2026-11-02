import fs from "node:fs";
import type { Config } from "./config.js";
import { resolveSourcePath } from "./files.js";
import { maskLatexComments, maskLatexLiteralContent } from "../shared/latexLiterals.js";
import { forEachLatexCommand, readLatexMandatoryArguments } from "../shared/latexScanner.js";

export const PROJECT_PREVIEW_BYTES = 64 * 1024;
const sentences = new Intl.Segmenter(undefined, { granularity: "sentence" });
const omittedCommands = new Set(["label", "ref", "eqref", "pageref", "cite", "citep", "citet", "citealp", "citeauthor", "citeyear",
  "autocite", "parencite", "textcite", "footcite", "footnote", "thanks", "url", "input", "include", "includegraphics", "bibliography", "bibliographystyle"]);

/** Display-only text, not TeX expansion or source used by compilation. */
function previewText(value: string): string {
  const source = maskLatexComments(maskLatexLiteralContent(value));
  const fragments: string[] = [];
  let cursor = 0;
  forEachLatexCommand(source, (command) => {
    if (command.from < cursor) return;
    fragments.push(source.slice(cursor, command.from));
    const argument = omittedCommands.has(command.name) || command.name === "begin" || command.name === "end"
      ? readLatexMandatoryArguments(source, command.to, 1)[0] : undefined;
    cursor = argument?.to ?? command.to;
    if (command.name === "LaTeX" || command.name === "TeX") fragments.push(command.name);
    else if (/^[%&_$#]$/.test(command.name)) fragments.push(command.name);
    else if (command.name === "\\" || command.name === "par") fragments.push(" ");
  });
  fragments.push(source.slice(cursor));
  return fragments.join("").replace(/[{}$]/g, "").replace(/~/g, " ").replace(/\s+/g, " ").replace(/\s+([,.;:!?，。；：！？])/gu, "$1").trim();
}

function excerpt(value: string): string {
  const first = sentences.segment(value)[Symbol.iterator]().next().value?.segment.trim() ?? "";
  const characters = Array.from(first);
  return characters.length > 240 ? `${characters.slice(0, 240).join("")}…` : first;
}

/** Abstract first sentence, then title. Never guess metadata from document-body commands. */
export function extractProjectPreview(source: string): string | null {
  let title = "", abstractStart = -1, abstractEnd = -1, bodyStart = -1, bodyEnd = source.length;
  forEachLatexCommand(source, (command) => {
    if (!["title", "begin", "end"].includes(command.name)) return;
    const argument = readLatexMandatoryArguments(source, command.to, 1)[0];
    if (!argument) return;
    const value = source.slice(argument.contentFrom, argument.contentTo);
    if (command.name === "title" && !title) title = previewText(value);
    if (command.name === "begin" && value.trim() === "abstract" && abstractStart < 0) abstractStart = argument.to;
    if (command.name === "end" && value.trim() === "abstract" && abstractStart >= 0 && abstractEnd < 0) abstractEnd = command.from;
    if (command.name === "begin" && value.trim() === "document" && bodyStart < 0) bodyStart = argument.to;
    if (command.name === "end" && value.trim() === "document" && bodyStart >= 0) bodyEnd = command.from;
  });
  const abstract = abstractStart >= 0 && abstractEnd >= abstractStart ? excerpt(previewText(source.slice(abstractStart, abstractEnd))) : "";
  if (abstract) return abstract;
  if (title) return Array.from(title).slice(0, 240).join("");
  if (bodyStart >= 0) {
    const body = source.slice(bodyStart, bodyEnd);
    // Only inspect the body to distinguish genuinely empty documents from
    // unavailable metadata. Formatting arguments and includes are not prose.
    return maskLatexComments(body).trim() ? null : "";
  }
  return maskLatexComments(source).trim() ? null : "";
}

/** Bounded main-file reads, coalesced across users and cached by file metadata. */
export class ProjectPreviewService {
  private readonly cache = new Map<string, { signature: string; preview: string | null }>();
  private readonly pending = new Map<string, Promise<string | null>>();
  constructor(private readonly config: Config) {}

  read(projectId: string, mainFile: string): Promise<string | null> {
    let file: string;
    try { file = resolveSourcePath(this.config, projectId, mainFile); }
    catch { return Promise.resolve(null); }
    const existing = this.pending.get(file);
    if (existing) return existing;
    const request = this.readFile(file).finally(() => { if (this.pending.get(file) === request) this.pending.delete(file); });
    this.pending.set(file, request);
    return request;
  }

  private async readFile(file: string): Promise<string | null> {
    try {
      const stat = await fs.promises.stat(file);
      if (!stat.isFile()) return null;
      const signature = `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
      const cached = this.cache.get(file);
      if (cached?.signature === signature) {
        this.cache.delete(file); this.cache.set(file, cached);
        return cached.preview;
      }
      const handle = await fs.promises.open(file, "r");
      let source: string;
      try {
        const buffer = Buffer.alloc(Math.min(stat.size, PROJECT_PREVIEW_BYTES));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        const bytes = buffer.subarray(0, bytesRead);
        if (bytes.includes(0)) return null;
        source = new TextDecoder("utf-8").decode(bytes, { stream: true });
      } finally { await handle.close(); }
      const extracted = extractProjectPreview(source);
      // An empty prefix says nothing about content beyond the bounded read.
      const preview = extracted === "" && stat.size > PROJECT_PREVIEW_BYTES ? null : extracted;
      this.cache.delete(file); this.cache.set(file, { signature, preview });
      if (this.cache.size > 128) this.cache.delete(this.cache.keys().next().value!);
      return preview;
    } catch { this.cache.delete(file); return null; }
  }
}
