/** A portable folder contains no user IDs or database-specific memberships. */
export const CITATION_FOLDER_FORMAT = "texlite-citation-folder";
export const CITATION_FOLDER_VERSION = 1;
export const MAX_CITATION_NOTES_BYTES = 64 * 1024;
export const MAX_CITATION_FOLDER_BYTES = 16 * 1024 * 1024;
export const MAX_CITATION_FOLDER_ENTRIES = 5000;

export interface CitationTransferEntry {
  citationKey: string;
  entryType: string;
  bibtex: string;
  title: string | null;
  authors: string | null;
  year: string | null;
  notes: string;
}

export interface CitationFolderBundle {
  format: typeof CITATION_FOLDER_FORMAT;
  version: typeof CITATION_FOLDER_VERSION;
  name: string;
  entries: CitationTransferEntry[];
}
