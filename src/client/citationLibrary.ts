// Keep browser-side discovery and server-side validation on the same parser.
// The shared implementation is dependency-free and safe to bundle in Vite.
export {
  MAX_CITATION_BIBTEX_BYTES,
  parseBibEntries,
  parseSingleBibEntry,
  type ParsedCitationEntry
} from "../server/citationLibrary";
