import type { LucideIcon } from "lucide-react";
import { BookOpen, File, FileArchive, FileAudio, FileCode2, FileCog, FileImage, FileSpreadsheet, FileText, FileType2, FileVideo, LibraryBig, NotepadText } from "lucide-react";
import { appPath } from "./basePath";

/** Semantic groups used by the project file tree. */
export type FileIconKind = "pdf" | "tex" | "bib" | "latexmkrc" | "image" | "markdown" | "text" | "code" | "spreadsheet" | "archive" | "audio" | "video" | "file";

const imageExtensions = new Set(["avif", "bmp", "gif", "ico", "jpeg", "jpg", "png", "svg", "webp", "eps"]);
const texExtensions = new Set(["latex", "ltx", "tex"]);
const codeExtensions = new Set([
  "aux", "blg", "bbl", "bst", "c", "cc", "cls", "cpp", "css", "dtx", "go", "h", "hpp", "html", "idx", "ilg", "ind", "ins", "java", "js", "json", "jsx",
  "lof", "log", "lot", "lua", "ltx", "nav", "out", "php", "py", "r", "rs", "sh", "snm", "sql", "sty", "tex", "toc", "ts", "tsx", "vrb", "xml", "yaml", "yml"
]);
const textExtensions = new Set(["cfg", "conf", "dat", "env", "ini", "text", "toml", "txt"]);
const spreadsheetExtensions = new Set(["csv", "ods", "tsv", "xls", "xlsx"]);
const archiveExtensions = new Set(["7z", "bz2", "gz", "rar", "tar", "xz", "zip"]);
const audioExtensions = new Set(["m4a", "mp3", "ogg", "wav"]);
const videoExtensions = new Set(["avi", "mkv", "mov", "mp4", "webm"]);

/**
 * Return the visual category for a project path. Matching is intentionally
 * extension-based and conservative so an unknown resource always has a
 * useful generic file icon.
 */
export function fileIconKind(filePath: string): FileIconKind {
  const basename = filePath.split("/").at(-1)?.toLocaleLowerCase() ?? "";
  if (basename === ".latexmkrc" || basename === "latexmkrc") return "latexmkrc";
  if (basename === "makefile" || basename === "dockerfile") return "code";
  if (basename === "readme" || basename.startsWith("readme.")) return "markdown";
  const extension = basename.includes(".") ? basename.slice(basename.lastIndexOf(".") + 1) : "";
  if (extension === "pdf") return "pdf";
  if (imageExtensions.has(extension)) return "image";
  if (extension === "md" || extension === "markdown" || extension === "mdown" || extension === "mkdn") return "markdown";
  if (texExtensions.has(extension)) return "tex";
  if (extension === "bib" || extension === "bibtex") return "bib";
  if (codeExtensions.has(extension)) return "code";
  if (textExtensions.has(extension)) return "text";
  if (spreadsheetExtensions.has(extension)) return "spreadsheet";
  if (archiveExtensions.has(extension)) return "archive";
  if (audioExtensions.has(extension)) return "audio";
  if (videoExtensions.has(extension)) return "video";
  return "file";
}

const icons: Record<FileIconKind, LucideIcon> = {
  pdf: FileType2,
  tex: FileCode2,
  bib: LibraryBig,
  latexmkrc: FileCog,
  image: FileImage,
  markdown: BookOpen,
  text: NotepadText,
  code: FileCode2,
  spreadsheet: FileSpreadsheet,
  archive: FileArchive,
  audio: FileAudio,
  video: FileVideo,
  file: FileText
};

export function FileTypeIcon({ path, size = 13 }: { path: string; size?: number }) {
  const kind = fileIconKind(path);
  if (kind === "pdf" || kind === "tex") {
    return <img className={`file-type-icon file-type-icon-${kind}`} src={appPath(`/${kind === "pdf" ? "pdf-file" : "tex-file"}.svg`)} width={size} height={size} alt="" aria-hidden="true" />;
  }
  const Icon = icons[kind] ?? File;
  return <Icon className={`file-type-icon file-type-icon-${kind}`} size={size} aria-hidden="true" />;
}
