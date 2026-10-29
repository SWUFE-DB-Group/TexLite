export type ProjectOwnershipScope = "all" | "owned" | "shared";

/** Full result counts before ownership filtering or pagination. */
export type ProjectCatalogCounts = Record<ProjectOwnershipScope, number>;
