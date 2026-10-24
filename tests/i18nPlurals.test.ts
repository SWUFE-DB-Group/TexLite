import { createInstance } from "i18next";
import { beforeAll, describe, expect, it } from "vitest";
import en from "../src/client/locales/en.json";
import zh from "../src/client/locales/zh.json";
import zhHant from "../src/client/locales/zh-Hant.json";

const translations = createInstance();
beforeAll(async () => {
  await translations.init({
    resources: { en: { translation: en }, zh: { translation: zh }, "zh-Hant": { translation: zhHant } },
    lng: "en", fallbackLng: "en", interpolation: { escapeValue: false }
  });
});

// Singular/plural pairs also cover irregular nouns, such as entry/entries.
const countedNouns = [
  ["auth.passwordMinimum", "character", "characters"],
  ["projects.pageOf", "project", "projects"],
  ["projects.unresolvedCommentsTooltip", "comment", "comments"],
  ["projects.unreadMentionsTooltip", "message", "messages"],
  ["users.ownedChoice", "project", "projects"],
  ["editor.wordCountWordsUnit", "word", "words"],
  ["editor.wordCountItemsUnit", "item", "items"],
  ["editor.wordCountExpressionsUnit", "expression", "expressions"],
  ["editor.wordCountParserErrors", "issue", "issues"],
  ["editor.commentDescription", "character", "characters"],
  ["editor.uploadSucceeded", "File", "Files"],
  ["editor.uploadFailedPartial", "file", "files"],
  ["editor.uploadOverwriteDescription", "file", "files"],
  ["editor.deletePathActiveDescription", "session", "sessions"],
  ["editor.collaboration.activeSessions", "session", "sessions"],
  ["editor.collaboration.showMoreSessions", "session", "sessions"],
  ["editor.search.matchCount", "match", "matches"],
  ["citationLibraryPagination.pageOf", "entry", "entries"],
  ["history.changedCount", "file", "files"],
  ["history.fileCount", "file", "files"],
  ["history.changedFilesHeading", "file", "files"],
  ["history.versionUsage", "snapshot", "snapshots"],
  ["selectionHistory.storageUsage", "segment", "segments"],
  ["selectionHistory.limited", "window", "windows"],
  ["selectionHistory.description", "character", "characters"],
  ["projectSettings.writingIssues", "issue", "issues"],
  ["git.changedFiles", "file", "files"],
  ["metrics.sessions", "session", "sessions"],
  ["metrics.rooms", "room", "rooms"],
  ["metrics.dirtyFiles", "file", "files"],
  ["completions.projectCommandArgs", "argument", "arguments"],
  ["editor.showEarlierReplies", "reply", "replies"],
  ["tags.projectCount", "project", "projects"],
  ["tags.deleteDescription", "project", "projects"]
] as const;

describe("count-aware translations", () => {
  it.each(countedNouns)("pluralizes %s for zero, one and two", (key, singular, plural) => {
    for (const count of [0, 1, 2]) {
      const text = translations.t(key, {
        lng: "en", count, total: count, unresolved: count, versions: 1, limit: count || "∞",
        page: 1, totalPages: 3, uploaded: count, message: "Network error", files: "main.tex",
        path: "main.tex", users: "Alice", tag: "Paper", used: "1.00", uniqueCount: count
      });
      expect(text, `${key} (${count})`).toMatch(new RegExp(`\\b${count === 1 ? singular : plural}\\b`, "i"));
      expect(text, `${key} (${count})`).not.toMatch(new RegExp(`\\b${count === 1 ? plural : singular}\\b`, "i"));
      expect(text).not.toContain("{{");
    }
  });

  describe.each([
    { language: "zh", project: "个项目", mention: "条未读消息", session: "个会话", file: "个文件", word: "字", room: "个房间", dirty: "个待保存文件" },
    { language: "zh-Hant", project: "個專案", mention: "條未讀訊息", session: "個工作階段", file: "個檔案", word: "詞", room: "個協作空間", dirty: "個待儲存檔案" }
  ])("$language quantities", (expected) => {
    const t = translations.getFixedT(expected.language);
    it.each([0, 1, 2])("keeps quantities natural (%i)", (count) => {
      expect(t("tags.projectCount", { count })).toBe(`${count} ${expected.project}`);
      expect(t("projects.unreadMentionsTooltip", { count })).toBe(`${count} ${expected.mention}`);
      expect(t("metrics.sessions", { count })).toBe(`${count} ${expected.session}`);
      expect(t("history.fileCount", { count })).toBe(`${count} ${expected.file}`);
      expect(t("editor.wordCountWordsUnit", { count })).toBe(expected.word);
      expect(t("metrics.roomsAndDirty", {
        rooms: t("metrics.rooms", { count }), dirty: t("metrics.dirtyFiles", { count })
      })).toBe(`${count} ${expected.room} · ${count} ${expected.dirty}`);
    });
  });

  it("uses the snapshot limit, not usage, for the noun after 'of'", () => {
    expect(translations.t("history.versionUsage", { count: 128, versions: 1, limit: 128 }))
      .toBe("1 of 128 ordinary snapshots");
    expect(translations.t("history.versionUsage", { count: 1, versions: 0, limit: 1 }))
      .toBe("0 of 1 ordinary snapshot");
    expect(translations.t("history.versionUsage", { count: 0, versions: 1, limit: "∞" }))
      .toBe("1 of ∞ ordinary snapshots");
  });

  it("leaves static section names independent of counts", () => {
    expect(translations.t("common.comments")).toBe("Comments");
    expect(translations.t("common.files")).toBe("Files");
    expect(translations.t("users.total", { count: 1 })).toBe("Users: 1");
  });
});
