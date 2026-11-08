/** Project Git payloads, shared by the server and the browser. */

export interface GitIdentity {
  name: string;
  email: string;
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
  /** The project owner's configured author identity for new commits. */
  commitIdentity: GitIdentity;
}
