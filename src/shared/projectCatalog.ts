export type ProjectOwnershipScope = "all" | "owned" | "shared";

export const DEFAULT_PROJECT_PAGE_SIZE = 32;

/** Counts across active and archived projects, before ownership filtering or pagination. */
export type ProjectCatalogCounts = Record<ProjectOwnershipScope, number>;
