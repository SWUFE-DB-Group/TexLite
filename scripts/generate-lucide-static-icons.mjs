import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const generatorVersion = 2;
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

const [{ createElement }, { renderToStaticMarkup }, { icons }] = await Promise.all([
  import("react"),
  import("react-dom/server"),
  import("lucide-react")
]);
const iconComponents = new Map();
for (const [componentName, component] of Object.entries(icons)) {
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
  await fs.writeFile(path.join(temporaryDirectory, "manifest.json"), JSON.stringify({
    generatorVersion,
    lucideVersion: lucidePackage.version,
    iconCount: iconComponents.size
  }), { encoding: "utf8", mode: 0o644 });
  await fs.rm(outputDirectory, { recursive: true, force: true });
  await fs.rename(temporaryDirectory, outputDirectory);
} catch (error) {
  await fs.rm(temporaryDirectory, { recursive: true, force: true });
  throw error;
}
