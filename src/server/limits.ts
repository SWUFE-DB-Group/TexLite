/**
 * Hard server-side limits shared by multiple features.
 *
 * These are deliberately not configuration settings: they cap memory used by
 * text previews and individual citation records independently of the project
 * upload limit.
 */
export const MAX_TEXT_PREVIEW_BYTES = 2 * 1024 * 1024;
export const MAX_CITATION_BIBTEX_BYTES = 512 * 1024;
