import { describe, expect, it } from "vitest";
import { serverErrorMessage, serverLocale } from "../src/server/i18n.js";
import { MIN_PASSWORD_LENGTH } from "../src/server/security.js";

describe("server API localization", () => {
  it("selects a supported browser language and falls back to English", () => {
    expect(serverLocale({ "accept-language": "zh-CN,zh;q=0.9,en;q=0.8" })).toBe("zh");
    expect(serverLocale({ "accept-language": "en-US,en;q=0.9" })).toBe("en");
    expect(serverLocale({ "accept-language": "ja-JP,ja;q=0.9" })).toBe("en");
    expect(serverLocale(undefined)).toBe("en");
  });

  it.each(["zh-TW", "zh-HK", "zh-MO", "zh-Hant", "zh-Hant-CN", "zh_Hant_TW"])("recognizes Traditional Chinese (%s)", (language) => {
    expect(serverLocale({ "accept-language": language })).toBe("zh-Hant");
  });

  it("honors script, explicit app locale and language preference weights", () => {
    expect(serverLocale({ "accept-language": "zh-Hans-TW" })).toBe("zh");
    expect(serverLocale({ "accept-language": "en-US,en;q=0.9,zh-TW;q=0.8" })).toBe("en");
    expect(serverLocale({ "accept-language": "en;q=0.5,zh-TW;q=0.9" })).toBe("zh-Hant");
    expect(serverLocale({ "accept-language": "zh-Hant;q=0,en;q=0.8" })).toBe("en");
    expect(serverLocale({ "accept-language": "zh-Hant;q=invalid,zh-CN;q=0.8" })).toBe("zh");
    expect(serverLocale({ "x-texlite-language": "zh-Hant", "accept-language": "en" })).toBe("zh-Hant");
    expect(serverLocale({ "x-texlite-language": "ja", "accept-language": "zh-TW" })).toBe("zh-Hant");
  });

  it("renders stable error codes and safe interpolation values", () => {
    expect(serverErrorMessage("en", "PASSWORD_TOO_SHORT", { minLength: MIN_PASSWORD_LENGTH }))
      .toBe(`The password must contain at least ${MIN_PASSWORD_LENGTH} characters.`);
    expect(serverErrorMessage("zh", "ZIP_DUPLICATE_ENTRY", { path: "main.tex" }))
      .toBe("ZIP 压缩包包含重复文件名：main.tex。");
    expect(serverErrorMessage("zh-Hant", "ZIP_DUPLICATE_ENTRY", { path: "章節.tex" }))
      .toBe("ZIP 壓縮檔包含重複檔名：章節.tex。");
    expect(serverErrorMessage("zh-Hant", "PASSWORD_TOO_SHORT", { minLength: MIN_PASSWORD_LENGTH }))
      .toBe(`密碼至少需要 ${MIN_PASSWORD_LENGTH} 個字元。`);
    expect(serverErrorMessage("zh-Hant", "UNKNOWN_ERROR_CODE")).toBe("無法完成請求。");
  });
});
