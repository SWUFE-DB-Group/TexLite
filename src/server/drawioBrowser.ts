import fs from "node:fs";
import path from "node:path";
import { httpError } from "./http.js";

/** Only Chromium-family browsers share this export backend. No browser is downloaded. */
export function browserCandidates(platform = process.platform, env = process.env): string[] {
  const names = platform === "win32" ? ["chromium.exe", "chrome.exe", "msedge.exe"]
    : ["chromium", "chromium-browser", "google-chrome-stable", "google-chrome", "chrome", "microsoft-edge-stable", "microsoft-edge", "msedge"];
  const directories = (env.PATH ?? "").split(platform === "win32" ? ";" : ":").filter(Boolean);
  const candidates = names.flatMap((name) => directories.map((directory) => path.join(directory, name)));
  if (platform === "darwin") candidates.push(
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge");
  if (platform === "win32") {
    for (const directory of [env.LOCALAPPDATA, env.PROGRAMFILES, env["PROGRAMFILES(X86)"]].filter((value): value is string => Boolean(value))) {
      candidates.push(path.join(directory, "Chromium", "Application", "chrome.exe"),
        path.join(directory, "Google", "Chrome", "Application", "chrome.exe"),
        path.join(directory, "Microsoft", "Edge", "Application", "msedge.exe"));
    }
  }
  // Keep the requested preference across standard install locations and PATH.
  const rank = (candidate: string) => /chromium/i.test(candidate) ? 0 : /(?:msedge|microsoft.edge)/i.test(candidate) ? 2 : 1;
  return [...new Set(candidates)].sort((left, right) => rank(left) - rank(right));
}

export async function findDrawioBrowser(configured?: string): Promise<string> {
  for (const candidate of configured ? [configured] : browserCandidates()) {
    try {
      await fs.promises.access(candidate, process.platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK);
      if ((await fs.promises.stat(candidate)).isFile()) return candidate;
    } catch { /* Missing candidates are optional; launch failures are reported separately. */ }
  }
  throw httpError(503, "DRAWIO_BROWSER_UNAVAILABLE");
}
