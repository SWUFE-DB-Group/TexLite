/** Completion data shared by the project index and the editor's live source. */
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
  classes: LatexCompletionItem[];
  files: LatexCompletionItem[];
}
