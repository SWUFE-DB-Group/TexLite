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

  it("renders stable error codes and safe interpolation values", () => {
    expect(serverErrorMessage("en", "PASSWORD_TOO_SHORT", { minLength: MIN_PASSWORD_LENGTH }))
      .toBe(`The password must contain at least ${MIN_PASSWORD_LENGTH} characters.`);
    expect(serverErrorMessage("zh", "ZIP_DUPLICATE_ENTRY", { path: "main.tex" }))
      .toBe("ZIP 压缩包包含重复文件名：main.tex。");
  });
});
