export type UpdateMethod = "npm" | "docker";

export interface UpdateNotice {
  currentVersion: string;
  latestVersion: string;
  method: UpdateMethod;
}

/** Commands are displayed for manual execution, never run by the server. */
export const UPDATE_COMMANDS: Record<UpdateMethod, string> = {
  npm: "npm install --global texlite@latest\ntexlite restart",
  docker: "git pull --ff-only\n./scripts/compose.sh pull\n./scripts/compose.sh up -d"
};
