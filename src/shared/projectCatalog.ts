export type ProjectOwnershipScope = "all" | "owned" | "shared";

/** Counts across active and archived projects, before ownership filtering or pagination. */
export type ProjectCatalogCounts = Record<ProjectOwnershipScope, number>;
