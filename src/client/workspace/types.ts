export type WorkspaceLayout = "editor-pdf" | "editor-only" | "pdf-only";
export type WordCountMode = "full" | "selection";

export type PreviewTab = "pdf" | "log" | "warnings" | "errors" | "artifacts" | "clean";
/** What the preview panel shows; "markdown" only while a Markdown file is active. */
export type PreviewSurface = "pdf" | "markdown" | "diagnostics";
export type DiagnosticTab = Exclude<PreviewTab, "pdf">;

export interface ProjectOutlineItem {
  path: string;
  line: number;
  level: number;
  title: string;
}

export interface CompileArtifact {
  path: string;
  size: number;
  viewable: boolean;
}
