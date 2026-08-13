export type WorkspaceLayout = "editor-pdf" | "editor-only" | "pdf-only";

export interface CompileArtifact {
  path: string;
  size: number;
  viewable: boolean;
}
