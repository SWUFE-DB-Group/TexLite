import { api } from "../api";
import { appPath } from "../basePath";

export type TikzGalleryType = "template" | "example" | "icon" | "plot";

/** Declared by the library, so a new category needs no code here. */
export interface TikzGalleryCategory {
  id: string;
  label: Record<string, string>;
  trademark?: boolean;
}

/** One entry of the library's generated catalog (see the add-on's README). */
export interface TikzGalleryItem {
  id: string;
  name: string;
  type: TikzGalleryType;
  category?: string;
  domain: string[];
  tags: string[];
  description: string;
  requires: string[];
  featured: boolean;
  tex: string;
  preview: string;
}

export const tikzGalleryAsset = (relative: string) => appPath(`/api/tikz-gallery/file?path=${encodeURIComponent(relative)}`);

export interface TikzGalleryCatalog {
  /** Credit supplied by the add-on; it is shown only with an https link. */
  attribution?: { url: string; text: Record<string, string> };
  categories: TikzGalleryCategory[];
  items: TikzGalleryItem[];
}

export function loadTikzGallery(signal?: AbortSignal): Promise<TikzGalleryCatalog> {
  return api<TikzGalleryCatalog>("/api/tikz-gallery/catalog", { signal });
}

export async function loadTikzGallerySource(item: TikzGalleryItem): Promise<string> {
  const response = await fetch(tikzGalleryAsset(item.tex));
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.text();
}

export function localizedText(text: Record<string, string>, language: string | undefined): string {
  return text[language ?? ""] ?? text.en ?? "";
}

/**
 * Every word of the query must appear in the figure's name or description
 * fields. The icon category only narrows browsing: a search covers all icons.
 */
export function filterTikzGallery(items: TikzGalleryItem[], type: TikzGalleryType, iconCategory: string, query: string): TikzGalleryItem[] {
  const words = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return items.filter((item) => {
    if (item.type !== type || (type === "icon" && !words.length && item.category !== iconCategory)) return false;
    const text = [item.id, item.name, item.description, ...item.tags, ...item.domain].join(" ").toLocaleLowerCase();
    return words.every((word) => text.includes(word));
  });
}

export function tikzCategoryLabel(category: TikzGalleryCategory, language: string | undefined): string {
  return localizedText(category.label, language) || category.id;
}

export function tikzGalleryDestination(item: TikzGalleryItem, folder: string | null): string {
  return `${folder ?? "figures"}/${item.id}.tex`;
}
