import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { icons, type LucideIcon } from "lucide-react";
import { normalizeLucideIconName } from "./projectIcons.js";

/** Convert public Lucide component exports, e.g. AlarmClockMinus, to slugs. */
function lucideSlug(componentName: string): string {
  return componentName
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLocaleLowerCase();
}

// `icons` is Lucide's public all-icons export.  Do not rely on its generated
// dynamic import table: that is an implementation detail and has differed
// across package versions and module loaders.  This index stays server-only,
// so supporting the complete installed icon set does not enlarge the browser
// bundle.
const installedIcons = icons as Record<string, LucideIcon>;
const iconComponents = new Map<string, LucideIcon>();
for (const [componentName, component] of Object.entries(installedIcons)) {
  const slug = lucideSlug(componentName);
  if (!iconComponents.has(slug)) iconComponents.set(slug, component);
}
const renderedIcons = new Map<string, string>();

/** Resolve an official Lucide icon slug to an installed icon. */
export function resolveLucideIconName(value: unknown): string | null {
  const name = normalizeLucideIconName(value);
  return name && iconComponents.has(name) ? name : null;
}

/** Render a verified Lucide icon once for use as a small, cacheable SVG mask. */
export async function lucideIconSvg(name: string): Promise<string | null> {
  const Icon = iconComponents.get(name);
  if (!Icon) return null;
  const cached = renderedIcons.get(name);
  if (cached) return cached;
  const svg = renderToStaticMarkup(createElement(Icon, {
    size: 24,
    strokeWidth: 1.9,
    color: "#000",
    "aria-hidden": true
  }));
  renderedIcons.set(name, svg);
  return svg;
}
