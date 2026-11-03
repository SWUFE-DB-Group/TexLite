import { MAX_CITATION_NOTES_BYTES } from "../shared/citationTransfer.js";
import { httpError, ValidationError } from "./http.js";
import { MAX_CITATION_BIBTEX_BYTES } from "./limits.js";

export interface CitationInput {
  bibtex: string;
  citationKey: string;
  entryType: string;
  title: string | null;
  authors: string | null;
  year: string | null;
  /** Omitted by project .bib updates, which must preserve private notes. */
  notes?: string;
}

function nullableText(value: unknown, max: number): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.length > max) throw new ValidationError();
  return value.trim() || null;
}

export function citationInput(value: unknown): CitationInput {
  if (typeof value !== "object" || value === null) throw new ValidationError();
  const body = value as Record<string, unknown>;
  if (typeof body.bibtex !== "string" || !body.bibtex.trim()) throw new ValidationError();
  if (Buffer.byteLength(body.bibtex, "utf8") > MAX_CITATION_BIBTEX_BYTES) throw httpError(413, "CITATION_TOO_LARGE");
  if (typeof body.citationKey !== "string" || !body.citationKey.trim() || body.citationKey.length > 512) throw new ValidationError();
  if (typeof body.entryType !== "string" || !body.entryType.trim() || body.entryType.length > 128) throw new ValidationError();
  if (body.notes !== undefined) {
    if (typeof body.notes !== "string") throw new ValidationError();
    if (Buffer.byteLength(body.notes, "utf8") > MAX_CITATION_NOTES_BYTES) throw httpError(413, "CITATION_NOTES_TOO_LARGE");
  }
  return {
    bibtex: body.bibtex.trim(), citationKey: body.citationKey.trim(), entryType: body.entryType.trim(),
    title: nullableText(body.title, 2048), authors: nullableText(body.authors, 2048), year: nullableText(body.year, 128),
    notes: body.notes as string | undefined
  };
}
