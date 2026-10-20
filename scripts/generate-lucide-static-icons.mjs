import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { legacyLucideBrandIcons } from "../src/shared/legacyLucideBrandIcons.ts";

const generatorVersion = 3;
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const lucidePackagePath = path.join(repositoryRoot, "node_modules", "lucide-react", "package.json");
const outputDirectory = path.join(repositoryRoot, "dist", "shared", "lucide-icons");
const manifestPath = path.join(outputDirectory, "manifest.json");

function lucideSlug(componentName) {
  return componentName
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLocaleLowerCase();
}

async function currentManifest() {
  try {
    return JSON.parse(await fs.readFile(manifestPath, "utf8"));
  } catch {
    return null;
  }
}

async function outputIsCurrent(lucideVersion) {
  const manifest = await currentManifest();
  if (!manifest || manifest.generatorVersion !== generatorVersion || manifest.lucideVersion !== lucideVersion
    || !Number.isInteger(manifest.iconCount) || manifest.iconCount <= 0) return false;
  try {
    const entries = await fs.readdir(outputDirectory);
    return entries.filter((entry) => entry.endsWith(".svg")).length === manifest.iconCount;
  } catch {
    return false;
  }
}

const lucidePackage = JSON.parse(await fs.readFile(lucidePackagePath, "utf8"));
if (await outputIsCurrent(lucidePackage.version)) process.exit(0);

const [{ createElement }, { renderToStaticMarkup }, lucide, { default: dynamicIconImports }] = await Promise.all([
  import("react"),
  import("react-dom/server"),
  import("lucide-react"),
  import("lucide-react/dynamicIconImports.mjs")
]);
const iconComponents = new Map();
// The published import map includes official slugs and supported aliases.
// Lucide 1.x's `icons` object alone omits some aliases (e.g. book-marked).
for (const [name, loadIcon] of Object.entries(dynamicIconImports)) {
  const { default: Icon } = await loadIcon();
  iconComponents.set(name, Icon);
}
// Preserve slugs produced by the previous generator, including digit suffixes
// such as file-code2. Keep React-specific export aliases out of the catalog.
const knownComponents = new Set(Object.values(lucide.icons));
for (const [componentName, component] of Object.entries(lucide)) {
  if (componentName.startsWith("Lucide") || componentName.endsWith("Icon") || !knownComponents.has(component)) continue;
  const name = lucideSlug(componentName);
  if (!iconComponents.has(name)) iconComponents.set(name, component);
}

const temporaryDirectory = `${outputDirectory}.tmp-${process.pid}-${randomUUID()}`;
await fs.mkdir(temporaryDirectory, { recursive: true, mode: 0o755 });
try {
  for (const [name, Icon] of iconComponents) {
    const svg = renderToStaticMarkup(createElement(Icon, {
      size: 24,
      strokeWidth: 1.9,
      color: "#000",
      "aria-hidden": true
    }));
    await fs.writeFile(path.join(temporaryDirectory, `${name}.svg`), svg, { encoding: "utf8", mode: 0o644 });
  }
  // Brand icons were removed in Lucide 1.x. Retain their SVGs so existing
  // project selections still render without depending on the old package.
  for (const [name, svg] of Object.entries(legacyLucideBrandIcons)) {
    if (!iconComponents.has(name)) await fs.writeFile(path.join(temporaryDirectory, `${name}.svg`), svg, { encoding: "utf8", mode: 0o644 });
  }
  await fs.writeFile(path.join(temporaryDirectory, "manifest.json"), JSON.stringify({
    generatorVersion,
    lucideVersion: lucidePackage.version,
    iconCount: new Set([...iconComponents.keys(), ...Object.keys(legacyLucideBrandIcons)]).size
  }), { encoding: "utf8", mode: 0o644 });
  await fs.rm(outputDirectory, { recursive: true, force: true });
  await fs.rename(temporaryDirectory, outputDirectory);
} catch (error) {
  await fs.rm(temporaryDirectory, { recursive: true, force: true });
  throw error;
}
