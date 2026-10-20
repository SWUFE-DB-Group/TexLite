import { afterEach, describe, expect, it, vi } from "vitest";

describe("document language", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  async function loadLanguage(browserLanguage: string, savedLanguage?: string) {
    vi.resetModules();
    const documentElement = { lang: "zh-CN" };
    const storage = new Map<string, string>();
    if (savedLanguage) storage.set("i18nextLng", savedLanguage);
    vi.stubGlobal("document", { documentElement });
    vi.stubGlobal("navigator", { language: browserLanguage, languages: [browserLanguage] });
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
        removeItem: (key: string) => storage.delete(key)
      }
    });
    const { default: i18n } = await import("../src/client/i18n");
    if (!i18n.isInitialized) {
      await new Promise<void>((resolve) => i18n.on("initialized", () => resolve()));
    }
    return { i18n, documentElement, storage };
  }

  it.each([
    ["en-US", undefined, "en"],
    ["zh-TW", undefined, "zh-CN"],
    ["fr-FR", undefined, "en"],
    ["zh-CN", "en", "en"]
  ])("uses the resolved UI language on startup (%s, saved %s)", async (browser, saved, expected) => {
    const { documentElement } = await loadLanguage(browser, saved);
    expect(documentElement.lang).toBe(expected);
  });

  it("updates the HTML language immediately when switching in either direction", async () => {
    const { i18n, documentElement, storage } = await loadLanguage("zh-CN");
    expect(documentElement.lang).toBe("zh-CN");

    await i18n.changeLanguage("en");
    expect(documentElement.lang).toBe("en");
    expect(storage.get("i18nextLng")).toBe("en");

    await i18n.changeLanguage("zh");
    expect(documentElement.lang).toBe("zh-CN");
    expect(storage.get("i18nextLng")).toBe("zh");
  });

  it("restores the chosen language after reloading with a different browser language", async () => {
    const first = await loadLanguage("en-US");
    await first.i18n.changeLanguage("zh");

    const reloaded = await loadLanguage("en-GB", first.storage.get("i18nextLng"));
    expect(reloaded.i18n.resolvedLanguage).toBe("zh");
    expect(reloaded.documentElement.lang).toBe("zh-CN");
    expect(reloaded.i18n.t("auth.logout")).toBe("退出");
  });

  it.each([
    ["en", 0, "0 projects"],
    ["en", 1, "1 project"],
    ["en", 2, "2 projects"],
    ["zh", 0, "0 个项目"],
    ["zh", 1, "1 个项目"],
    ["zh", 2, "2 个项目"]
  ] as const)("resolves plural project counts in %s (%s)", async (language, count, expected) => {
    const { i18n } = await loadLanguage(language);
    expect(i18n.t("tags.projectCount", { count })).toBe(expected);
  });

  it("interpolates display names as text without interpreting translation markup", async () => {
    const { i18n } = await loadLanguage("en-US");
    const name = "Alice & Bob <研究组>";
    expect(i18n.t("account.menu", { name })).toBe(`User menu for ${name}`);

    await i18n.changeLanguage("zh");
    expect(i18n.t("account.menu", { name })).toBe(`${name} 的用户菜单`);
  });
});
