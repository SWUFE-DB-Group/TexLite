import { describe, expect, it } from "vitest";
import { formatRelativeTime } from "../src/client/relativeTime";
import i18n from "../src/client/i18n";

const now = Date.parse("2026-10-21T12:00:00Z");
function relative(minutesAgo: number, locale = "en", singleUnit = false) {
  return formatRelativeTime(new Date(now - minutesAgo * 60_000).toISOString(), locale, now,
    (key, options) => i18n.t(key, { ...options, lng: locale }), { singleUnit });
}

describe("shared project/comment relative times", () => {
  it("uses a current-time label for new comments instead of a future zero minutes", () => {
    expect(relative(0)).toBe("now");
    expect(relative(0.5)).toBe("now");
    expect(relative(0, "zh")).toBe("现在");
  });

  it("keeps the dashboard's minute, hour/minute, day/hour and day-only precision", () => {
    expect(relative(16)).toBe("16 minutes ago");
    expect(relative(60)).toBe("1h ago");
    expect(relative(153)).toBe("2h 33m ago");
    expect(relative(24 * 60)).toBe("1d ago");
    expect(relative(25 * 60)).toBe("1d 1h ago");
    expect(relative(6 * 24 * 60)).toBe("6d ago");
    expect(relative(16, "zh")).toBe("16 分钟前");
    expect(relative(153, "zh")).toBe("2 小时 33 分钟前");
    expect(relative(25 * 60, "zh")).toBe("1 天 1 小时前");
    expect(relative(6 * 24 * 60, "zh")).toBe("6 天前");
  });

  it("supports future clock differences and invalid legacy dates without throwing", () => {
    expect(relative(-16)).toBe("in 16 minutes");
    expect(relative(-153)).toBe("in 2h 33m");
    expect(formatRelativeTime("invalid", "en", now, (key) => key)).toBe("invalid");
  });

  it.each([
    ["en", "16m ago", "16h ago", "1d ago", "in 2h"],
    ["zh", "16 分钟前", "16 小时前", "1 天前", "2 小时后"],
    ["zh-Hant", "16 分鐘前", "16 小時前", "1 天前", "2 小時後"]
  ])("uses one floored unit for grid labels in %s without changing full precision", (locale, minutes, hours, days, future) => {
    expect(relative(16, locale, true)).toBe(minutes);
    expect(relative(16 * 60 + 31, locale, true)).toBe(hours);
    expect(relative(25 * 60, locale, true)).toBe(days);
    expect(relative(-153, locale, true)).toBe(future);
    expect(relative(0, locale, true)).toBe(relative(0, locale));
  });

  it("uses Traditional Chinese for both Intl and translated relative times", () => {
    expect(relative(0, "zh-Hant")).toBe("現在");
    expect(relative(16, "zh-Hant")).toBe("16 分鐘前");
    expect(relative(153, "zh-Hant")).toBe("2 小時 33 分鐘前");
    expect(relative(25 * 60, "zh-Hant")).toBe("1 天 1 小時前");
    expect(relative(6 * 24 * 60, "zh-Hant")).toBe("6 天前");
  });

  it.each(["zh", "zh-Hant"])("keeps number/Han spacing consistent across time units and clock directions (%s)", (locale) => {
    for (const minutes of [16, 60, 153, 24 * 60, 25 * 60, 6 * 24 * 60]) {
      for (const direction of [-1, 1]) {
        const label = relative(minutes * direction, locale);
        expect(label).not.toMatch(/\d\p{Script=Han}|\p{Script=Han}\d/u);
        expect(label).not.toContain("  ");
      }
    }
  });
});
