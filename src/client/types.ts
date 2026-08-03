export interface SiteConfig {
  siteName: string;
  adminEmail: string;
  allowedEngines?: Array<"pdflatex" | "xelatex" | "lualatex">;
  allowProjectLatexmkrc?: boolean;
  maxUploadSizeMB?: number;
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
