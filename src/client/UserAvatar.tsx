import { useState } from "react";
import { AVATAR_RENDER_VERSION, avatarInitial, isAvatarStyle } from "../shared/avatars";
import { appPath } from "./basePath";

export function userAvatarUrl(id: string | null | undefined, style: string | null | undefined, preview = false): string | null {
  return id && isAvatarStyle(style) ? appPath(`/api/users/${encodeURIComponent(id)}/avatar.svg?style=${style}&v=${AVATAR_RENDER_VERSION}${preview ? "&preview=1" : ""}`) : null;
}

/** Decorative avatar: adjacent author text remains the accessible identity. */
export function UserAvatar({ userId, name, username, avatarStyle, className = "", preview = false }: {
  userId?: string | null; name?: string | null; username?: string | null;
  avatarStyle?: string | null; className?: string; preview?: boolean;
}) {
  const source = userAvatarUrl(userId, avatarStyle, preview);
  const initial = avatarInitial(name, username);
  return <span className={`user-avatar ${className}`.trim()} aria-hidden="true">
    {source ? <AvatarImage key={source} source={source} initial={initial} lazy={preview} /> : initial}
  </span>;
}

function AvatarImage({ source, initial, lazy }: { source: string; initial: string; lazy: boolean }) {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  return <>{(!loaded || failed) && initial}
    {!failed && <img src={source} alt="" decoding="async" loading={lazy ? "lazy" : "eager"}
      style={{ visibility: loaded ? "visible" : "hidden" }}
      onLoad={() => setLoaded(true)} onError={() => setFailed(true)} />}
  </>;
}
