import { describe, expect, it } from "vitest";
import { formatDateTime, spaceDateTimeNumbers } from "../src/client/dateTime";

describe("UI date/time spacing", () => {
  it("separates both sides of Han/number boundaries without duplicating existing spaces", () => {
    expect(spaceDateTimeNumbers("2026年10月24日 下午2:03")).toBe("2026 年 10 月 24 日 下午 2:03");
    expect(spaceDateTimeNumbers("2 小时 33 分钟前")).toBe("2 小时 33 分钟前");
    expect(spaceDateTimeNumbers("10/24/2026, 2:03 PM")).toBe("10/24/2026, 2:03 PM");
  });

  it.each(["en", "zh", "zh-Hant"])("preserves native date/time values and locale conventions apart from Han/number spacing (%s)", (locale) => {
    const date = new Date("2026-10-24T14:03:00Z");
    const variants: Array<Intl.DateTimeFormatOptions | undefined> = [
      undefined,
      { year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true, timeZone: "UTC" },
      { hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: "UTC" },
      { year: "numeric", month: "2-digit", day: "2-digit", timeZone: "UTC" }
    ];
    for (const options of variants) {
      const value = formatDateTime(date, locale, options);
      const native = date.toLocaleString(locale, options);
      expect(value.replace(/\s/g, "")).toBe(native.replace(/\s/g, ""));
      expect(value).not.toMatch(/\d\p{Script=Han}|\p{Script=Han}\d/u);
      if (locale === "en") expect(value).toBe(native);
    }
  });

  it("keeps invalid original date values untouched", () => {
    expect(formatDateTime("第2026版-not-a-date", "zh")).toBe("第2026版-not-a-date");
    expect(formatDateTime(new Date(NaN), "en")).toBe("Invalid Date");
  });
});
