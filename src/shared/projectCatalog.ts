export type ProjectOwnershipScope = "all" | "owned" | "shared";

export const DEFAULT_PROJECT_PAGE_SIZE = 32;

/** Display-only metadata from a bounded main-document read; never TeX expansion. */
export interface ProjectSourcePreview {
  title: string;
  abstract: string;
}

/** Counts across active and archived projects, before ownership filtering or pagination. */
export type ProjectCatalogCounts = Record<ProjectOwnershipScope, number>;
