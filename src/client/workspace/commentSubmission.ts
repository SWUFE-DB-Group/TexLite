import type { SuggestionDraft } from "../../shared/comments";

/** The submitted payload, not merely whether the edit controls are expanded. */
export function commentSubmission(text: string, original: string, suggestion: SuggestionDraft | null, authorId?: string) {
  const hasComment = Boolean(text.trim());
  const edit = suggestion && original && suggestion.replacementText !== original ? suggestion : null;
  const issue = !hasComment && !edit ? "empty" : edit?.reviewerId && edit.reviewerId === authorId ? "selfReview" : edit && !edit.reviewerId ? "reviewer" : null;
  const kind = edit ? hasComment ? "commentAndEdit" : "editOnly" : "commentOnly";
  return { hasComment, edit, issue, kind } as const;
}
