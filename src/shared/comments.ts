/** Transport types shared by comment routes and the workspace cache. */
export interface ProjectCommentSummary {
  totalCount: number;
  unresolvedCount: number;
  filePaths: string[];
}

export interface CommentReply {
  id: string;
  authorId: string | null;
  authorUsername: string | null;
  authorDisplayName: string | null;
  authorAvatarStyle?: string | null;
  content: string;
  createdAt: string;
  updatedAt: string;
  editedAt: string | null;
}

export interface Comment {
  id: string;
  filePath: string;
  /** Response-only manuscript reading order; never inferred from a mutation. */
  sourceOrder?: number;
  authorId: string | null;
  authorUsername: string | null;
  authorDisplayName: string | null;
  authorAvatarStyle?: string | null;
  selectedText: string;
  /** Last attached context survives deletion so undo can recover the anchor. */
  contextBefore?: string;
  contextAfter?: string;
  /** Response-only revision against which the persisted anchor was read. */
  anchorSourceHash?: string;
  startOffset: number;
  endOffset: number;
  startLine: number;
  endLine: number;
  content: string;
  resolved: boolean;
  resolvedById: string | null;
  resolvedByUsername: string | null;
  resolvedByDisplayName: string | null;
  resolvedAt: string | null;
  orphaned: boolean;
  createdAt: string;
  updatedAt: string;
  editedAt: string | null;
  replies: CommentReply[];
}

export interface MentionableUser { id: string; username: string; displayName: string }

export interface CommentMention {
  id: string;
  projectId: string;
  commentId: string;
  replyId: string | null;
  filePath: string;
  content: string;
  resolved: boolean;
  createdAt: string;
  readAt: string | null;
  readReason: "opened" | "resolved" | "manual" | null;
}

export type CommentResolution = Pick<Comment, "id" | "filePath" | "resolved" | "resolvedById" | "resolvedByUsername" | "resolvedByDisplayName" | "resolvedAt" | "updatedAt">;
export type CommentEdit = Pick<Comment, "id" | "filePath" | "content" | "updatedAt" | "editedAt">;

/** Field-specific acknowledgements must not replace live anchors or replies. */
export type CommentChange =
  | { kind: "created"; comment: Comment }
  | { kind: "edited"; comment: CommentEdit }
  | { kind: "resolved"; resolution: CommentResolution }
  | { kind: "deleted"; commentId: string; filePath: string }
  | { kind: "reply-saved"; commentId: string; filePath: string; reply: CommentReply }
  | { kind: "reply-deleted"; commentId: string; filePath: string; replyId: string };

export interface CommentMutationResult {
  change: CommentChange;
  summary: ProjectCommentSummary;
}
