import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("i18n resources", () => {
  it("keeps English and Chinese translation keys in sync", () => {
    const root = path.resolve("src/client/locales");
    const en = JSON.parse(fs.readFileSync(path.join(root, "en.json"), "utf8"));
    const zh = JSON.parse(fs.readFileSync(path.join(root, "zh.json"), "utf8"));
    expect(flattenKeys(zh)).toEqual(flattenKeys(en));
  });
});

function flattenKeys(value: Record<string, unknown>, prefix = ""): string[] {
  return Object.entries(value).flatMap(([key, nested]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return nested && typeof nested === "object" && !Array.isArray(nested)
      ? flattenKeys(nested as Record<string, unknown>, path)
      : [path];
  }).sort();
}
