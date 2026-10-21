/** DiceBear's Characters category; no arbitrary paths or external avatar URLs. */
export const AVATAR_STYLES = [
  "adventurer", "adventurer-neutral", "avataaars", "avataaars-neutral",
  "big-ears", "big-ears-neutral", "big-smile", "bottts", "bottts-neutral",
  "cameo", "clay", "critters", "croodles", "croodles-neutral", "cutouts",
  "dylan", "fun-emoji", "gaze", "line-face", "lorelei", "lorelei-neutral",
  "marbles", "micah", "miniavs", "moods", "notionists", "notionists-neutral",
  "open-peeps", "personas", "pixel-art", "pixel-art-neutral", "pixelbot",
  "shadows", "sprouts", "thumbs", "toon-head", "voxel-art", "voxel-bot"
] as const;
export type AvatarStyle = typeof AVATAR_STYLES[number];
/** Invalidate browser images generated with the earlier user-ID seed. */
export const AVATAR_RENDER_VERSION = 2;

export function isAvatarStyle(value: unknown): value is AvatarStyle {
  return typeof value === "string" && (AVATAR_STYLES as readonly string[]).includes(value);
}

export function avatarInitial(displayName: string | null | undefined, username?: string | null): string {
  return Array.from(displayName?.trim() || username?.trim() || "?")[0]?.toLocaleUpperCase() ?? "?";
}
