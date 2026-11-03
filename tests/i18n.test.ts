import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("i18n resources", () => {
  function catalog(locale: string): Record<string, unknown> {
    const root = path.resolve("src/client/locales");
    return JSON.parse(fs.readFileSync(path.join(root, `${locale}.json`), "utf8"));
  }

  it.each(["zh", "zh-Hant"])("keeps %s translation keys in sync with English", (locale) => {
    expect(flattenKeys(catalog(locale))).toEqual(flattenKeys(catalog("en")));
  });

  it("preserves interpolation variables and rich-text tags in Traditional Chinese", () => {
    const source = flattenStrings(catalog("zh"));
    const traditional = flattenStrings(catalog("zh-Hant"));
    const tokens = (text: string) => text.match(/{{[^}]+}}|<\/?[a-zA-Z][^>]*>/g)?.sort() ?? [];
    for (const [key, value] of Object.entries(source)) {
      expect(tokens(traditional[key]!), key).toEqual(tokens(value));
    }
  });

  it("uses consistent Traditional Chinese software and writing terminology", () => {
    const strings = flattenStrings(catalog("zh-Hant"));
    expect(strings["projects.title"]).toBe("專案");
    expect(strings["common.files"]).toBe("檔案");
    expect(strings["common.save"]).toBe("儲存");
    expect(strings["common.readOnly"]).toBe("唯讀");
    expect(strings["common.comments"]).toBe("批註");
    expect(strings["editor.destinationFolder"]).toBe("目標資料夾");
    expect(strings["projectSettings.spellCheck"]).toBe("拼字與文法檢查");
    expect(strings["git.repository"]).toBe("儲存庫");
  });

  it.each(["zh", "zh-Hant"])("separates Han characters from literal numbers and numeric placeholders (%s)", (locale) => {
    const number = "(?:\\d|\\{\\{(?:count|total|current|page|totalPages|days|hours|minutes|seconds|line|column|versions|limit|uploaded|uniqueCount)\\}\\})";
    const touching = new RegExp(`\\p{Script=Han}${number}|${number}\\p{Script=Han}`, "u");
    for (const [key, value] of Object.entries(flattenStrings(catalog(locale)))) {
      expect(value, key).not.toMatch(touching);
    }
  });
});

function flattenStrings(value: Record<string, unknown>, prefix = ""): Record<string, string> {
  return Object.fromEntries(Object.entries(value).flatMap(([key, nested]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return typeof nested === "string" ? [[path, nested]]
      : Object.entries(flattenStrings(nested as Record<string, unknown>, path));
  }));
}

function flattenKeys(value: Record<string, unknown>, prefix = ""): string[] {
  return Object.entries(value).flatMap(([key, nested]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return nested && typeof nested === "object" && !Array.isArray(nested)
      ? flattenKeys(nested as Record<string, unknown>, path)
      : [path];
  }).sort();
}
