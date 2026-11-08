import type { TFunction } from "i18next";

/**
 * Attribution for history written with a coding agent's help. Agents are not
 * told apart: the user who ran the task stays the author, and "Coding Agent"
 * is added after them.
 */
export function withCodingAgent(names: string, hasAgent: boolean, t: TFunction): string {
  return hasAgent ? t("history.withCodingAgent", { names }) : names;
}

/**
 * Who changed a snapshot. Without a single author an automatic save merged
 * several people's saves; with agent changes that is stated rather than
 * implying the agent worked alone.
 */
export function snapshotAttribution(
  version: { author: { name: string; username: string } | null; reason: string; hasAgent: boolean },
  t: TFunction
): string {
  const author = version.author?.name || version.author?.username;
  if (author) return withCodingAgent(author, version.hasAgent, t);
  if (!version.hasAgent) return version.reason === "autosave" ? t("history.reasons.autosave") : t("editor.deletedUser");
  return withCodingAgent(version.reason === "autosave" ? t("history.multipleAuthors") : t("editor.deletedUser"), true, t);
}
