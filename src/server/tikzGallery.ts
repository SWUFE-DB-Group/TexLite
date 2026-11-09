import fs from "node:fs";
import path from "node:path";

/** The catalog format this TexLite can read; see the add-on's README. */
const SUPPORTED_CATALOG_VERSION = 1;
const MAX_FIGURE_FILE_BYTES = 16 * 1024 * 1024;

interface CatalogItem { tex: string; preview: string }
interface Catalog { version: number; items: CatalogItem[] }

export type TikzGalleryCatalogResult =
  | { status: "ok"; catalog: Catalog }
  | { status: "unavailable" }
  | { status: "incompatible" };

/** A file inside `root` once symbolic links are followed, or null. */
function containedFile(root: string, relative: string): string | null {
  try {
    const realRoot = fs.realpathSync(root);
    const real = fs.realpathSync(path.resolve(realRoot, relative));
    return real.startsWith(`${realRoot}${path.sep}`) && fs.statSync(real).isFile() ? real : null;
  } catch {
    return null;
  }
}

function isCatalog(value: unknown): value is Catalog {
  const catalog = value as Partial<Catalog> | null;
  return typeof catalog === "object" && catalog !== null && catalog.version === SUPPORTED_CATALOG_VERSION && Array.isArray(catalog.items)
    && catalog.items.every((item) => typeof item?.tex === "string" && typeof item.preview === "string");
}

/**
 * Reads the add-on an administrator placed on this host. The directory is a
 * whole repository, so only the files its catalog lists are ever exposed. It
 * is read per request (the parse is cached) so `git pull` needs no restart.
 */
export class TikzGalleryLibrary {
  private cached: { stamp: string; result: TikzGalleryCatalogResult; listed: Set<string> } | null = null;

  constructor(private readonly directory: string) {}

  private load() {
    const file = containedFile(this.directory, "catalog.json");
    if (!file) return { result: { status: "unavailable" } as TikzGalleryCatalogResult, listed: new Set<string>() };
    const stat = fs.statSync(file);
    const stamp = `${stat.mtimeMs}:${stat.size}`;
    if (this.cached?.stamp === stamp) return this.cached;
    let parsed: unknown;
    try { parsed = JSON.parse(fs.readFileSync(file, "utf8")); } catch { parsed = null; }
    const result: TikzGalleryCatalogResult = isCatalog(parsed) ? { status: "ok", catalog: parsed } : { status: "incompatible" };
    const listed = new Set(result.status === "ok" ? result.catalog.items.flatMap(({ tex, preview }) => [tex, preview]) : []);
    this.cached = { stamp, result, listed };
    return this.cached;
  }

  catalog(): TikzGalleryCatalogResult {
    return this.load().result;
  }

  /** The path of a figure source or preview the catalog lists, or null. */
  listedFile(relative: string): string | null {
    if (!this.load().listed.has(relative) || !/\.(?:tex|svg)$/i.test(relative)) return null;
    const file = containedFile(this.directory, relative);
    return file && fs.statSync(file).size <= MAX_FIGURE_FILE_BYTES ? file : null;
  }
}
