import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const CONFIG_FILE_NAME = "texlite.config.json";

export interface RuntimeEnvironment {
  XDG_CONFIG_HOME?: string;
  XDG_DATA_HOME?: string;
  HOME?: string;
  TEXLITE_CONFIG?: string;
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function xdgConfigHome(environment: RuntimeEnvironment = process.env, home = os.homedir()): string {
  return path.resolve(nonEmpty(environment.XDG_CONFIG_HOME) ?? path.join(home, ".config"));
}

export function xdgDataHome(environment: RuntimeEnvironment = process.env, home = os.homedir()): string {
  return path.resolve(nonEmpty(environment.XDG_DATA_HOME) ?? path.join(home, ".local", "share"));
}

export function texliteConfigDirectory(environment: RuntimeEnvironment = process.env, home = os.homedir()): string {
  return path.join(xdgConfigHome(environment, home), "texlite");
}

export function defaultConfigPath(environment: RuntimeEnvironment = process.env, home = os.homedir()): string {
  return path.join(texliteConfigDirectory(environment, home), CONFIG_FILE_NAME);
}

export function defaultDataDirectory(environment: RuntimeEnvironment = process.env, home = os.homedir()): string {
  return path.join(xdgDataHome(environment, home), "texlite");
}

export function resolveConfigPath(explicitPath?: string, environment: RuntimeEnvironment = process.env): string {
  const configured = nonEmpty(explicitPath) ?? nonEmpty(environment.TEXLITE_CONFIG);
  return path.resolve(configured ?? defaultConfigPath(environment));
}

/** The directory containing the installed package's compiled assets. */
export function packageRootDirectory(moduleUrl: string = import.meta.url): string {
  return path.resolve(path.dirname(fileURLToPath(moduleUrl)), "..", "..");
}

/** The Vite output beside dist/server in a production npm package. */
export function packageClientDirectory(moduleUrl: string = import.meta.url): string {
  // Resolve from the package root rather than from the source/compiled module
  // directory. This keeps source execution (`tsx src/server/...`) pointed at
  // the repository's `dist/client` after a build, while compiled npm installs
  // resolve to `<package>/dist/client` as well.
  return path.join(packageRootDirectory(moduleUrl), "dist", "client");
}

export function packageServerEntry(moduleUrl: string = import.meta.url): string {
  return path.resolve(path.dirname(fileURLToPath(moduleUrl)), "service.js");
}
