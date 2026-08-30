/**
 * A curated project-icon vocabulary.
 *
 * The client renders these with the Lucide icons already used throughout the
 * application. They are the fast, searchable defaults; the server separately
 * validates advanced choices against the installed Lucide catalogue.
 */
export const projectIconNames = [
  "file-text",
  "book-open",
  "notebook-pen",
  "book-marked",
  "scroll-text",
  "library",
  "graduation-cap",
  "presentation",
  "image",
  "folder-kanban",
  "microscope",
  "flask-conical",
  "test-tube-diagonal",
  "atom",
  "dna",
  "telescope",
  "earth",
  "map",
  "languages",
  "university",
  "code-2",
  "file-code-2",
  "database",
  "server",
  "network",
  "circuit-board",
  "brain",
  "brain-circuit",
  "bot",
  "shield-check",
  "workflow",
  "sigma",
  "calculator",
  "chart-no-axes-combined",
  "line-chart",
  "bar-chart-3",
  "pie-chart",
  "chart-scatter",
  "file-spreadsheet",
  "file-chart-column-increasing",
  "lightbulb",
  "rocket",
  "target",
  "sparkles",
  "file-pen-line",
  "file-stack",
  "folder",
  "folder-open",
  "folder-archive",
  "archive",
  "bookmark",
  "newspaper",
  "notepad-text",
  "sticky-note",
  "pen-tool",
  "quote",
  "list-tree",
  "file-search",
  "beaker",
  "test-tubes",
  "folder-git-2",
  "git-branch",
  "terminal",
  "braces",
  "regex",
  "cpu",
  "hard-drive",
  "cloud",
  "users-round",
  "calendar-days"
] as const;

export type ProjectIconName = typeof projectIconNames[number];

const projectIconNameSet = new Set<string>(projectIconNames);

export function isProjectIconName(value: unknown): value is ProjectIconName {
  return typeof value === "string" && projectIconNameSet.has(value);
}

/**
 * Normalize an official Lucide icon slug (`file-text`). The optional
 * `lucide:` prefix makes values copied from Iconify equally convenient.
 * Availability is intentionally checked by the server-only Lucide module.
 */
export function normalizeLucideIconName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const compact = value.trim().replace(/^lucide:/i, "");
  if (!compact || compact.length > 96) return null;
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(compact) ? compact : null;
}
