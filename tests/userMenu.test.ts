import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { UserMenu } from "../src/client/UserMenu";
import { ThemeSwitcher } from "../src/client/ThemeSwitcher";
import { LanguageSwitcher } from "../src/client/LanguageSwitcher";
import i18n from "../src/client/i18n";
import type { User } from "../src/client/types";

const user: User = { id: "user", username: "alice", displayName: "Alice", role: "user", disabled: false, createdAt: "2026-10-20T00:00:00Z", canCreateProjects: false, mustChangePassword: false };

describe("user menu", () => {
  it("offers all three native language names and selects Traditional Chinese", async () => {
    const previous = i18n.language;
    try {
      await i18n.changeLanguage("zh-Hant");
      const html = renderToStaticMarkup(createElement(LanguageSwitcher));
      expect(html).toContain('value="en">English</option>');
      expect(html).toContain('value="zh">简体中文</option>');
      expect(html).toContain('value="zh-Hant" selected="">繁體中文</option>');
      expect(html).toContain('aria-label="語言"');
    } finally {
      await i18n.changeLanguage(previous);
    }
  });

  it("uses a single named avatar trigger and keeps controls inside a closed popover", () => {
    const html = renderToStaticMarkup(createElement(UserMenu, { user, onGitHub: () => {}, onSignOut: async () => {} }));
    expect(html).toContain(i18n.t("account.menu", { name: "Alice" }));
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('class="user-avatar user-menu-avatar" aria-hidden="true">A</span>');
    expect(html).not.toContain('class="user-menu-content"');
    expect(html).not.toContain("<select");
  });

  it("supports Chinese display names and a username fallback", () => {
    const render = (displayName: string) => renderToStaticMarkup(createElement(UserMenu, { user: { ...user, displayName }, onGitHub: () => {}, onSignOut: async () => {} }));
    expect(render("陈老师")).toContain('aria-hidden="true">陈</span>');
    expect(render("")).toContain('class="user-menu-name">alice</span>');
  });

  it("offers light, dark and system modes with an accessible selected state", () => {
    const html = renderToStaticMarkup(createElement(ThemeSwitcher));
    expect(html).toContain('role="group"');
    for (const mode of ["light", "dark", "system"]) expect(html).toContain(i18n.t(`theme.${mode}`));
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(1);
    expect(html.match(/aria-pressed="false"/g)).toHaveLength(2);
  });
});
