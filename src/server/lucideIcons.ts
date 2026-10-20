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
let selectableIconNames: Set<string> | null = null;

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
  if (!name) return null;
  if (!selectableIconNames) {
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(staticIconDirectory, "manifest.json"), "utf8")) as {
        selectableIconNames: string[];
      };
      if (!Array.isArray(manifest.selectableIconNames)) return null;
      selectableIconNames = new Set(manifest.selectableIconNames);
    } catch {
      return null;
    }
  }
  return selectableIconNames.has(name) && staticIconExists(name) ? name : null;
}

/** Render retained legacy SVGs too, while new selections use the official catalog. */
export async function lucideIconSvg(value: string): Promise<string | null> {
  const name = normalizeLucideIconName(value);
  if (!name) return null;
  const cached = svgCache.get(name);
  if (cached !== undefined) return cached;
  if (!staticIconExists(name)) {
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
