export interface SiteConfig {
  siteName: string;
  adminEmail: string;
  /** Server-enforced password policy, exposed for immediate form validation. */
  minPasswordLength: number;
  /** Server-enforced cap for one citation-library BibTeX entry. */
  maxCitationBibtexBytes: number;
  allowedEngines?: Array<"pdflatex" | "xelatex" | "lualatex">;
  allowProjectLatexmkrc?: boolean;
  maxUploadSizeMB: number;
  maxCollaborativeFileSizeMB: number;
}

export interface User {
  id: string;
  username: string;
  displayName: string;
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
  mainFile: string;
  latexmkrc: string | null;
  engine: "pdflatex" | "xelatex" | "lualatex";
  permission: "read" | "edit" | "owner";
  tags: ProjectTag[];
  unresolvedCommentCount?: number;
  commentCount?: number;
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

export interface FileEntry {
  path: string;
  type: "file" | "directory";
  size?: number;
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
  title: string | null;
  authors: string | null;
  year: string | null;
  revision: number;
  tags: CitationLibraryTag[];
  createdAt: string;
  updatedAt: string;
}

export interface CitationLibraryTag {
  id: string;
  name: string;
  color: TagColor;
  ownerId: string;
}

export type HistoryReason = "initial" | "autosave" | "file" | "settings" | "git" | "restore" | "checkpoint";

export interface HistoryVersion {
  id: string;
  reason: HistoryReason;
  label: string | null;
  createdAt: string;
  author: { id: string; username: string; name: string } | null;
  changedPaths: string[];
  fileCount: number;
  totalSize: number;
}

export interface HistoryVersionDetail {
  version: HistoryVersion;
  settings: { mainFile: string; engine: Project["engine"]; latexmkrc: string | null };
  files: Array<{ path: string; size: number }>;
}

export interface HistoryStats {
  versionCount: number;
  ordinaryVersionCount: number;
  labeledVersionCount: number;
  objectCount: number;
  objectBytes: number;
  maxVersions: number;
  maxStorageBytes: number;
  storageLimitExceeded: boolean;
}

export interface GitCommit {
  sha: string;
  shortSha: string;
  authorName: string;
  authorEmail: string;
  authoredAt: string;
  message: string;
}

export interface ProjectGitStatus {
  initialized: boolean;
  tokenConfigured: boolean;
  githubLogin: string | null;
  remoteUrl: string | null;
  repositoryName: string | null;
  repositoryHtmlUrl: string | null;
  defaultBranch: string;
  branch: string | null;
  dirty: boolean;
  restorable: boolean;
  changedFiles: number;
  ahead: number;
  latestCommit: GitCommit | null;
}

export type LatexCompletionKind = "keyword" | "function" | "class" | "constant" | "text";

export interface LatexCompletionItem {
  label: string;
  detail: string;
  kind: LatexCompletionKind;
  apply?: string;
  info?: string;
  source?: string;
}

export interface LatexCompletionIndex {
  commands: LatexCompletionItem[];
  environments: LatexCompletionItem[];
  labels: LatexCompletionItem[];
  citations: LatexCompletionItem[];
  packages: LatexCompletionItem[];
  files: LatexCompletionItem[];
}

export interface Comment {
  id: string;
  authorId: string | null;
  authorUsername: string | null;
  authorDisplayName: string | null;
  selectedText: string;
  startOffset: number;
  endOffset: number;
  startLine: number;
  endLine: number;
  content: string;
  resolved: boolean;
  orphaned: boolean;
  createdAt: string;
  updatedAt: string;
  editedAt: string | null;
  replies: CommentReply[];
}

export interface CommentReply {
  id: string;
  authorId: string | null;
  authorUsername: string | null;
  authorDisplayName: string | null;
  content: string;
  createdAt: string;
  updatedAt: string;
  editedAt: string | null;
}
