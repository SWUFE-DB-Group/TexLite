import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeLucideIconName } from "../shared/projectIcons.js";

// The source and compiled server resolve this to the same package-local
// directory: <package>/dist/shared/lucide-icons.  The build script creates
// those SVGs from the installed client dependency, keeping React and the
// complete Lucide component catalogue out of the long-lived server process.
const staticIconDirectory = fileURLToPath(new URL("../../dist/shared/lucide-icons/", import.meta.url));
const svgCache = new Map<string, string | null>();

function staticIconPath(name: string): string {
  return path.join(staticIconDirectory, `${name}.svg`);
}

function staticIconExists(name: string): boolean {
  try {
    return fs.statSync(staticIconPath(name)).isFile();
  } catch {
    return false;
  }
}

/** Resolve an official Lucide slug only when a generated static SVG exists. */
export function resolveLucideIconName(value: unknown): string | null {
  const name = normalizeLucideIconName(value);
  return name && staticIconExists(name) ? name : null;
}

/** Read a verified static SVG once for use as a small, cacheable CSS mask. */
export async function lucideIconSvg(name: string): Promise<string | null> {
  const cached = svgCache.get(name);
  if (cached !== undefined) return cached;
  if (!resolveLucideIconName(name)) {
    svgCache.set(name, null);
    return null;
  }
  try {
    const svg = await fs.promises.readFile(staticIconPath(name), "utf8");
    svgCache.set(name, svg);
    return svg;
  } catch {
    svgCache.set(name, null);
    return null;
  }
}
