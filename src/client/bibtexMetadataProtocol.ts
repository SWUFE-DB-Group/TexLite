import type { BibtexEntrySummary } from "./bibtex/entryMetadata";

export type BibtexMetadataFailureKind = "invalid" | "unavailable" | "timeout";

export interface BibtexMetadataWorkerRequest {
  id: number;
  source: string;
}

export type BibtexMetadataWorkerResponse =
  | { id: number; ok: true; entries: BibtexEntrySummary[] }
  | { id: number; ok: false; kind: BibtexMetadataFailureKind };
