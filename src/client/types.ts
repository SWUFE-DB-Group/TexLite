import type { ProjectCatalogCounts, ProjectOwnershipScope, ProjectSourcePreview } from "../shared/projectCatalog";
import type { HistoryVersion } from "../shared/historyProtocol";

export type {
  HistoryReason, HistoryStats, HistoryVersion, SelectionHistoryAuthor, SelectionHistoryEntry, SelectionHistoryResult
} from "../shared/historyProtocol";
/** The snapshot-list response as the browser receives it. */
export type { HistoryPageResponse as HistoryPage } from "../shared/historyProtocol";
export type { GitCommit, ProjectGitStatus } from "../shared/gitProtocol";

export interface SiteConfig {
  siteName: string;
  adminEmail: string;
  basePath: string;
  /** Server-enforced password policy, exposed for immediate form validation. */
  minPasswordLength: number;
  /** Server-enforced cap for one citation-library BibTeX entry. */
  maxCitationBibtexBytes: number;
  allowedEngines?: Array<"pdflatex" | "xelatex" | "lualatex">;
  tikzGalleryEnabled?: boolean;
  allowProjectLatexmkrc?: boolean;
  maxUploadSizeMB: number;
  maxCollaborativeFileSizeMB: number;
}

export interface User {
  id: string;
  username: string;
  displayName: string;
  avatarStyle?: string | null;
  role: "admin" | "user";
  disabled: boolean;
  mustChangePassword: boolean;
  canCreateProjects: boolean;
  createdAt: string;
  ownedProjects?: number;
}

export interface Project {
  id: string;
  ownerId: string;
  ownerUsername?: string;
  ownerDisplayName?: string;
  lastModifiedBy: string | null;
  lastModifiedUsername?: string | null;
  lastModifiedDisplayName?: string | null;
  name: string;
  /** Optional catalog metadata; empty fields mean no content, null means unavailable. */
  preview?: ProjectSourcePreview | null;
  mainFile: string;
  latexmkrc: string | null;
  engine: "pdflatex" | "xelatex" | "lualatex";
  /** A server-validated Lucide icon slug, or null to display the project initial. */
  icon: string | null;
  /** Shared project setting: run the optional host ChkTeX checker after edits. */
  chktexEnabled: boolean;
  permission: "read" | "edit" | "owner";
  /** Shared read/write members, excluding the owner; independent of online sessions. */
  sharedMemberCount?: number;
  tags: ProjectTag[];
  unresolvedCommentCount?: number;
  commentCount?: number;
  /** Unread @mentions addressed to the currently signed-in user only. */
  unreadMentionCount?: number;
  archived?: boolean;
  createdAt: string;
  updatedAt: string;
}

export type TagColor = "red" | "orange" | "yellow" | "green" | "blue" | "purple" | "gray";

export interface ProjectTag {
  id: string;
  name: string;
  color: TagColor;
}

export interface ProjectListPagination {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export type { ProjectOwnershipScope, ProjectCatalogCounts } from "../shared/projectCatalog";

export interface ProjectCatalogFilters {
  ownership: ProjectOwnershipScope;
  archived: boolean;
  search: string;
  tag: string;
  sort: "updated" | "created";
}

/** Keep the cached rows and the filters that produced them together. */
export interface DashboardData {
  projects: Project[];
  tags: ProjectTag[];
  pagination: ProjectListPagination;
  counts: ProjectCatalogCounts;
  filters: ProjectCatalogFilters;
}

export type { Comment, CommentReply, CommentMention, MentionableUser, ProjectCommentSummary } from "../shared/comments";

export interface FileEntry {
  path: string;
  type: "file" | "directory";
  size?: number;
  textContent?: boolean;
}

/** Counts returned by the host TeXcount command for a document or selection. */
export interface WordCountResult {
  mode: "full" | "selection";
  path: string;
  textWords: number;
  headerWords: number;
  captionWords: number;
  totalWords: number;
  headers: number;
  floats: number;
  inlineMath: number;
  displayMath: number;
  totalCharacters: number;
  files: number | null;
  parserErrors: number;
}

export interface CitationLibraryEntry {
  id: string;
  ownerId: string;
  ownerUsername: string | null;
  ownerDisplayName: string | null;
  citationKey: string;
  entryType: string;
  bibtex: string;
  notes: string;
  title: string | null;
  authors: string | null;
  year: string | null;
  venue: string | null;
  revision: number;
  tags: CitationLibraryTag[];
  collectionIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface CitationLibraryTag {
  id: string;
  name: string;
  color: TagColor;
  ownerId: string;
}

export interface HistoryVersionDetail {
  version: HistoryVersion;
  scoped?: boolean;
  settings: { mainFile: string; engine: Project["engine"]; latexmkrc: string | null; chktexEnabled?: boolean };
  files: Array<{ path: string; size: number; deleted?: boolean; textContent?: boolean }>;
}

export type { LatexCompletionKind, LatexCompletionItem, LatexCompletionIndex } from "../shared/latexCompletion";
