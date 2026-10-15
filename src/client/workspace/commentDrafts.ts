import { errorMessage } from "../errors";

export interface SourceSelection {
  selectedText: string;
  startOffset: number;
  endOffset: number;
}

export interface NewCommentDraft {
  filePath: string;
  selection: SourceSelection;
  sourceHash: string;
  content: string;
}

export interface CommentFormDraft {
  readonly content: string;
  readonly open: boolean;
  readonly pending: boolean;
  readonly error: string;
}

export type CommentDraftKey = "reply" | "edit-comment" | `edit-reply:${string}`;
export type ThreadDrafts = Readonly<Partial<Record<CommentDraftKey, CommentFormDraft>>>;
const EMPTY_THREAD: ThreadDrafts = Object.freeze({});

/** One instance per mounted project workspace. Never persisted or shared across users. */
export class CommentDraftStore {
  private readonly threads = new Map<string, ThreadDrafts>();
  private readonly listeners = new Map<string, Set<() => void>>();
  private readonly newComments = new Map<string, NewCommentDraft>();

  getThread(id: string): ThreadDrafts { return this.threads.get(id) ?? EMPTY_THREAD; }

  subscribe(id: string, listener: () => void): () => void {
    const listeners = this.listeners.get(id) ?? new Set();
    listeners.add(listener);
    this.listeners.set(id, listeners);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.listeners.delete(id);
    };
  }

  private publish(id: string, drafts: ThreadDrafts): void {
    if (Object.keys(drafts).length) this.threads.set(id, drafts);
    else this.threads.delete(id);
    for (const listener of this.listeners.get(id) ?? []) listener();
  }

  isPending(id: string): boolean { return Object.values(this.getThread(id)).some((draft) => draft?.pending); }

  open(id: string, key: CommentDraftKey, content = ""): void {
    if (this.isPending(id)) return;
    const drafts = { ...this.getThread(id) };
    // Keep each reply's text, while retaining the existing single reply-edit UI.
    if (key.startsWith("edit-reply:")) {
      for (const [other, draft] of Object.entries(drafts)) {
        if (other.startsWith("edit-reply:") && draft?.open) drafts[other as CommentDraftKey] = { ...draft, open: false };
      }
    }
    const current = drafts[key];
    drafts[key] = { content, pending: false, error: "", ...current, open: true };
    this.publish(id, drafts);
  }

  change(id: string, key: CommentDraftKey, content: string): void {
    const current = this.getThread(id)[key];
    if (!current || this.isPending(id)) return;
    this.publish(id, { ...this.getThread(id), [key]: { ...current, content } });
  }

  hide(id: string, key: CommentDraftKey): void {
    const current = this.getThread(id)[key];
    if (!current || this.isPending(id)) return;
    this.publish(id, { ...this.getThread(id), [key]: { ...current, open: false } });
  }

  discard(id: string, key?: CommentDraftKey): void {
    const drafts = { ...this.getThread(id) };
    if (key === undefined) { this.publish(id, EMPTY_THREAD); return; }
    delete drafts[key];
    this.publish(id, drafts);
  }

  async submit(id: string, key: CommentDraftKey, action: (content: string) => Promise<boolean>, failureMessage: string): Promise<boolean> {
    const draft = this.getThread(id)[key];
    if (!draft || !draft.content.trim() || this.isPending(id)) return false;
    const pending = { ...draft, pending: true, error: "" };
    this.publish(id, { ...this.getThread(id), [key]: pending });
    let failure = failureMessage;
    try {
      if (await action(draft.content)) {
        // A deleted/replaced draft must not be resurrected by a late request.
        if (this.getThread(id)[key] === pending) this.discard(id, key);
        return true;
      }
    } catch (error) { failure = errorMessage(error); }
    if (this.getThread(id)[key] === pending) {
      this.publish(id, { ...this.getThread(id), [key]: { ...draft, pending: false, error: failure } });
    }
    return false;
  }

  getNew(filePath: string): NewCommentDraft | undefined { return this.newComments.get(filePath); }
  setNew(draft: NewCommentDraft): void {
    this.newComments.set(draft.filePath, { ...draft, selection: { ...draft.selection } });
  }
  discardNew(filePath: string): void { this.newComments.delete(filePath); }
}
