import type { FileEntry } from "../types";

/** Discover project rc files in latexmk's root-file preference order. */
export function projectLatexmkrcCandidates(files: readonly FileEntry[], configuredPath: string | null): string[] {
  const candidates = files
    .filter((entry) => entry.type === "file" && ["latexmkrc", ".latexmkrc"].includes(entry.path.split("/").at(-1) ?? ""))
    .map((entry) => entry.path);
  if (configuredPath && files.some((entry) => entry.type === "file" && entry.path === configuredPath) && !candidates.includes(configuredPath)) {
    candidates.push(configuredPath);
  }
  const priority = (file: string): number => file === "latexmkrc" ? 0 : file === ".latexmkrc" ? 1 : file.includes("/") ? 3 : 2;
  return candidates.sort((left, right) => priority(left) - priority(right) || left.localeCompare(right));
}
