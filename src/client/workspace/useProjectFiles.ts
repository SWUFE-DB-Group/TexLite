import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { useTranslation } from "react-i18next";
import { api, localizedResponseError } from "../api";
import { errorMessage } from "../errors";
import type { FileEntry, Project, SiteConfig } from "../types";

export type ResourcePreviewKind = "image" | "pdf" | "text" | "unsupported" | "large";
export interface ResourcePreview {
  path: string;
  kind: ResourcePreviewKind;
  size: number;
  url: string;
  content?: string;
}
export interface PendingUpload {
  files: File[];
  directory: string;
  collisions: string[];
}
export interface FileLoadOptions {
  signal?: AbortSignal;
  isCurrent?: () => boolean;
}

export const MAX_DIRECT_RESOURCE_PREVIEW_BYTES = 10 * 1024 * 1024;
const binaryFileExtensions = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".ico", ".avif", ".pdf", ".zip", ".gz", ".bz2", ".xz", ".tar", ".rar", ".7z",
  ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".odt", ".ods", ".odp", ".mp3", ".mp4", ".wav", ".ogg", ".webm", ".mov", ".avi",
  ".wasm", ".exe", ".bin", ".so", ".dll", ".class", ".jar"
]);

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export function parentFolders(filePath: string): string[] {
  const parts = filePath.split("/").filter(Boolean);
  parts.pop();
  return parts.map((_part, index) => parts.slice(0, index + 1).join("/"));
}

export function pathContains(root: string, candidate: string): boolean {
  return Boolean(root && candidate) && (candidate === root || candidate.startsWith(`${root}/`));
}

function isTextFile(filePath: string): boolean {
  const extension = `.${filePath.split(".").at(-1)?.toLocaleLowerCase() ?? ""}`;
  return !binaryFileExtensions.has(extension);
}

export function isEditableTextFile(filePath: string): boolean {
  return /(?:\.(?:tex|bib|sty|cls|txt|md)|latexmkrc)$/i.test(filePath);
}

function resourcePreviewKind(filePath: string): ResourcePreviewKind {
  const extension = filePath.split(".").at(-1)?.toLocaleLowerCase() ?? "";
  if (extension === "pdf") return "pdf";
  if (["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif"].includes(extension)) return "image";
  if (isTextFile(filePath)) return "text";
  return "unsupported";
}

function rawFileUrl(projectId: string, filePath: string): string {
  return `/api/projects/${projectId}/file/raw?path=${encodeURIComponent(filePath)}`;
}

interface UseProjectFilesOptions {
  projectId: string;
  site: SiteConfig;
  activeFile: string;
  dirty: boolean;
  save: () => Promise<boolean>;
  onError: (message: string) => void;
  onProject: (project: Project) => void;
  onActiveFile: (updater: string | ((current: string) => string)) => void;
  onActiveMainFile: (updater: string | ((current: string) => string)) => void;
  onRootDocuments: (updater: (current: Set<string>) => Set<string>) => void;
}

export function useProjectFiles({
  projectId, site, activeFile, dirty, save, onError, onProject, onActiveFile, onActiveMainFile, onRootDocuments
}: UseProjectFilesOptions) {
  const { t } = useTranslation();
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [newFileOpen, setNewFileOpen] = useState(false);
  const [newFilePath, setNewFilePath] = useState("");
  const [resourcePreview, setResourcePreview] = useState<ResourcePreview | null>(null);
  const [resourcePreviewLoading, setResourcePreviewLoading] = useState(false);
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [fileDialogError, setFileDialogError] = useState("");
  const [selectedFolder, setSelectedFolder] = useState("");
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const [moveEntry, setMoveEntry] = useState<FileEntry | null>(null);
  const [moveName, setMoveName] = useState("");
  const [moveDestination, setMoveDestination] = useState("");
  const [deleteEntry, setDeleteEntry] = useState<FileEntry | null>(null);
  const [fileDragActive, setFileDragActive] = useState(false);
  const [uploadConflict, setUploadConflict] = useState<PendingUpload | null>(null);
  const [uploadingFiles, setUploadingFiles] = useState(false);
  const filesRequest = useRef<AbortController | null>(null);
  const resourceRequest = useRef<AbortController | null>(null);

  const loadFiles = async (options: FileLoadOptions = {}) => {
    filesRequest.current?.abort();
    filesRequest.current = null;
    const controller = options.signal ? null : new AbortController();
    if (controller) filesRequest.current = controller;
    try {
      const result = await api<{ files: FileEntry[] }>(
        `/api/projects/${projectId}/files`,
        { signal: options.signal ?? controller?.signal }
      );
      if (!options.isCurrent || options.isCurrent()) setFiles(result.files);
      return result.files;
    } catch (error) {
      if (!isAbortError(error)) throw error;
      return undefined;
    } finally {
      if (controller && filesRequest.current === controller) filesRequest.current = null;
    }
  };

  const createFile = async () => {
    if (!newFilePath.trim() || newFilePath.trim().endsWith("/")) return;
    setFileDialogError("");
    try {
      await api(`/api/projects/${projectId}/file`, {
        method: "POST", body: JSON.stringify({ path: newFilePath, content: "" })
      });
      await loadFiles();
      onActiveFile(newFilePath);
      setExpandedFolders((current) => new Set([...current, ...parentFolders(newFilePath)]));
      setNewFileOpen(false);
      setNewFilePath("");
    } catch (error) { setFileDialogError(errorMessage(error)); }
  };

  const createFolder = async () => {
    if (!newFolderName.trim()) return;
    setFileDialogError("");
    const folderPath = selectedFolder ? `${selectedFolder}/${newFolderName.trim()}` : newFolderName.trim();
    try {
      const result = await api<{ path: string }>(`/api/projects/${projectId}/folders`, {
        method: "POST", body: JSON.stringify({ path: folderPath })
      });
      await loadFiles();
      setExpandedFolders((current) => new Set([...current, ...parentFolders(result.path), result.path]));
      setSelectedFolder(result.path);
      setNewFolderOpen(false);
      setNewFolderName("");
    } catch (error) { setFileDialogError(errorMessage(error)); }
  };

  const uploadFiles = async (
    filesToUpload: File[], overwritePaths: ReadonlySet<string> = new Set(), directoryOverride = selectedFolder
  ) => {
    if (!filesToUpload.length) return;
    const maxSize = site.maxUploadSizeMB;
    const oversized = filesToUpload.find((file) => file.size > maxSize * 1024 * 1024);
    if (oversized) return onError(t("errors.fileTooLarge", { size: maxSize }));
    const directory = directoryOverride;
    const uploadPaths = filesToUpload.map((file) => directory ? `${directory}/${file.name}` : file.name);
    const pathCounts = new Map<string, number>();
    for (const uploadPath of uploadPaths) pathCounts.set(uploadPath, (pathCounts.get(uploadPath) ?? 0) + 1);
    const duplicateNames = [...pathCounts.entries()].filter(([, count]) => count > 1).map(([uploadPath]) => uploadPath);
    if (duplicateNames.length) return onError(t("errors.duplicateUploadNames", { files: duplicateNames.join(", ") }));
    const existingPaths = new Set(files.map((entry) => entry.path));
    const collisions = [...new Set(uploadPaths.filter((uploadPath) => existingPaths.has(uploadPath) && !overwritePaths.has(uploadPath)))];
    if (collisions.length) {
      setUploadConflict({ files: filesToUpload, directory, collisions });
      return;
    }
    setUploadConflict(null);
    setUploadingFiles(true);
    try {
      const query = new URLSearchParams();
      if (directory) query.set("directory", directory);
      let lastTextPath = "";
      for (const [index, file] of filesToUpload.entries()) {
        const uploadPath = uploadPaths[index];
        query.delete("overwrite");
        if (overwritePaths.has(uploadPath)) query.set("overwrite", "1");
        const destination = query.toString() ? `?${query.toString()}` : "";
        const data = new FormData();
        data.append("file", file);
        const response = await fetch(`/api/projects/${projectId}/upload${destination}`, { method: "POST", body: data });
        const result = await response.json().catch(() => ({})) as { code?: unknown; path?: unknown };
        if (!response.ok) {
          if (response.status === 409 && !overwritePaths.has(uploadPath) && result.code === "FILE_EXISTS") {
            if (index > 0) await loadFiles();
            setUploadConflict({
              files: filesToUpload.slice(index),
              directory,
              collisions: [typeof result.path === "string" ? result.path : uploadPath]
            });
            return;
          }
          throw new Error(response.status === 409
            ? t("errors.pathConflict")
            : localizedResponseError(result, response.status, "errors.upload"));
        }
        if (typeof result.path === "string" && isEditableTextFile(result.path)) lastTextPath = result.path;
      }
      await loadFiles();
      if (lastTextPath) onActiveFile(lastTextPath);
    } catch (error) { onError(errorMessage(error)); }
    finally { setUploadingFiles(false); }
  };

  const upload = async (event: ChangeEvent<HTMLInputElement>) => {
    await uploadFiles(Array.from(event.target.files ?? []));
    event.target.value = "";
  };

  const previewFile = async (entry: FileEntry) => {
    resourceRequest.current?.abort();
    resourceRequest.current = null;
    setResourcePreviewLoading(false);
    const url = rawFileUrl(projectId, entry.path);
    if ((entry.size ?? 0) > MAX_DIRECT_RESOURCE_PREVIEW_BYTES) {
      setResourcePreview({ path: entry.path, kind: "large", size: entry.size ?? 0, url });
      return;
    }
    const kind = resourcePreviewKind(entry.path);
    if (kind !== "text") {
      setResourcePreview({ path: entry.path, kind, size: entry.size ?? 0, url });
      return;
    }
    setResourcePreview({ path: entry.path, kind, size: entry.size ?? 0, url, content: "" });
    setResourcePreviewLoading(true);
    const controller = new AbortController();
    resourceRequest.current = controller;
    try {
      const response = await fetch(url, { signal: controller.signal });
      const text = await response.text();
      if (!response.ok) throw new Error(text || t("errors.request", { status: response.status }));
      setResourcePreview((current) => current?.path === entry.path ? { ...current, content: text } : current);
    } catch (error) {
      if (!isAbortError(error)) {
        setResourcePreview(null);
        onError(errorMessage(error));
      }
    } finally {
      if (resourceRequest.current === controller) {
        resourceRequest.current = null;
        setResourcePreviewLoading(false);
      }
    }
  };

  const openFile = (entry: FileEntry) => {
    const kind = resourcePreviewKind(entry.path);
    const maxCollaborativeBytes = site.maxCollaborativeFileSizeMB * 1024 * 1024;
    if ((entry.size ?? 0) > MAX_DIRECT_RESOURCE_PREVIEW_BYTES
      || (isEditableTextFile(entry.path) && (entry.size ?? 0) > maxCollaborativeBytes)
      || kind !== "text" || !isEditableTextFile(entry.path)) {
      void previewFile(entry);
    } else {
      onActiveFile(entry.path);
    }
  };

  const movePath = async () => {
    if (!moveEntry) return;
    const destinationName = moveName.trim();
    if (!destinationName) return;
    setFileDialogError("");
    try {
      if (!(await save())) return;
      const result = await api<{ path: string }>(`/api/projects/${projectId}/path`, {
        method: "PATCH", body: JSON.stringify({ source: moveEntry.path, destinationDirectory: moveDestination, destinationName })
      });
      const remap = (value: string) => value === moveEntry.path
        ? result.path
        : value.startsWith(`${moveEntry.path}/`) ? `${result.path}${value.slice(moveEntry.path.length)}` : value;
      onActiveFile((current) => remap(current));
      onActiveMainFile((current) => remap(current));
      onRootDocuments((current) => new Set([...current].map(remap)));
      setSelectedFolder((current) => current ? remap(current) : current);
      const [fileResult, projectResult] = await Promise.all([
        api<{ files: FileEntry[] }>(`/api/projects/${projectId}/files`),
        api<{ project: Project }>(`/api/projects/${projectId}`)
      ]);
      setFiles(fileResult.files);
      onProject(projectResult.project);
      setExpandedFolders((current) => new Set([...current, ...parentFolders(result.path), moveDestination].filter(Boolean)));
      setMoveEntry(null);
      setMoveName("");
      setMoveDestination("");
    } catch (error) { setFileDialogError(errorMessage(error)); }
  };

  const removePath = async () => {
    if (!deleteEntry) return;
    setFileDialogError("");
    try {
      if (dirty && !(await save())) return;
      await api(`/api/projects/${projectId}/file?path=${encodeURIComponent(deleteEntry.path)}`, { method: "DELETE" });
      setDeleteEntry(null);
    } catch (error) { setFileDialogError(errorMessage(error)); }
  };

  useEffect(() => () => {
    filesRequest.current?.abort();
    resourceRequest.current?.abort();
  }, []);

  useEffect(() => {
    resourceRequest.current?.abort();
    resourceRequest.current = null;
    setResourcePreviewLoading(false);
  }, [activeFile]);

  const directoryEntries = files.filter((entry) => entry.type === "directory");
  const visibleEntries = files.filter((entry) => parentFolders(entry.path).every((folder) => expandedFolders.has(folder)));

  return {
    files, setFiles, loadFiles,
    newFileOpen, setNewFileOpen, newFilePath, setNewFilePath,
    resourcePreview, setResourcePreview, resourcePreviewLoading, setResourcePreviewLoading,
    newFolderOpen, setNewFolderOpen, newFolderName, setNewFolderName,
    fileDialogError, setFileDialogError,
    selectedFolder, setSelectedFolder,
    expandedFolders, setExpandedFolders,
    moveEntry, setMoveEntry, moveName, setMoveName, moveDestination, setMoveDestination,
    deleteEntry, setDeleteEntry,
    fileDragActive, setFileDragActive,
    uploadConflict, setUploadConflict, uploadingFiles,
    directoryEntries, visibleEntries,
    createFile, createFolder, uploadFiles, upload, openFile, movePath, removePath
  };
}
