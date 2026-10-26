import type { CollaborationStatus } from "../collaboration";

/** Connection labels overlay save progress without becoming stored save state. */
export function collaborationSaveState(status: CollaborationStatus, saveState: string, hasPendingDraft: boolean): string {
  if (status === "connected") return saveState;
  if (status === "disconnected" && hasPendingDraft) return "editor.offlineDraft";
  return `editor.collaboration.${status}`;
}
