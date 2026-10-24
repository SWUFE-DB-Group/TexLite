import { describe, expect, it } from "vitest";
import { formatRelativeTime } from "../src/client/relativeTime";
import i18n from "../src/client/i18n";

const now = Date.parse("2026-10-21T12:00:00Z");
function relative(minutesAgo: number, locale = "en") {
  return formatRelativeTime(new Date(now - minutesAgo * 60_000).toISOString(), locale, now,
    (key, options) => i18n.t(key, { ...options, lng: locale }));
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
    expect(relative(153, "zh")).toBe("2小时33分钟前");
    expect(relative(6 * 24 * 60, "zh")).toBe("6天前");
  });

  it("supports future clock differences and invalid legacy dates without throwing", () => {
    expect(relative(-16)).toBe("in 16 minutes");
    expect(relative(-153)).toBe("in 2h 33m");
    expect(formatRelativeTime("invalid", "en", now, (key) => key)).toBe("invalid");
  });

  it("uses Traditional Chinese for both Intl and translated relative times", () => {
    expect(relative(0, "zh-Hant")).toBe("現在");
    expect(relative(16, "zh-Hant")).toBe("16 分鐘前");
    expect(relative(153, "zh-Hant")).toBe("2小時33分鐘前");
    expect(relative(25 * 60, "zh-Hant")).toBe("1天1小時前");
    expect(relative(6 * 24 * 60, "zh-Hant")).toBe("6天前");
  });
});
