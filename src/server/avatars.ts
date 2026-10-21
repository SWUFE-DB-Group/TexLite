import { Avatar, Style } from "@dicebear/core";
import type { AvatarStyle } from "../shared/avatars.js";

// Only style definitions are shared in memory. Selected SVGs live in SQLite.
const styles = new Map<AvatarStyle, Promise<Style>>();

export async function generateUserAvatar(username: string, name: AvatarStyle): Promise<string> {
  let pending = styles.get(name);
  if (!pending) {
    pending = import(/* @vite-ignore */ `@dicebear/styles/${name}.json`, { with: { type: "json" } })
      .then((definition) => new Style(definition.default))
      .catch((error) => { styles.delete(name); throw error; });
    styles.set(name, pending);
  }
  return new Avatar(await pending, { seed: username, size: 96 }).toString();
}
