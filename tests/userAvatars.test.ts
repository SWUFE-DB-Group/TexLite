// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UserAvatar, userAvatarUrl } from "../src/client/UserAvatar";
import { AvatarSettingsDialog } from "../src/client/AvatarSettingsDialog";
import { AVATAR_STYLES, avatarInitial } from "../src/shared/avatars";
import { api } from "../src/client/api";
import i18n from "../src/client/i18n";
import type { User } from "../src/client/types";

vi.mock("../src/client/api", () => ({ api: vi.fn() }));
vi.mock("../src/client/Dialog", () => ({
  Modal: ({ children, footer }: { children: ReactNode; footer?: ReactNode }) => createElement("section", null, children, footer)
}));

const user: User = { id: "a", username: "alice", displayName: "Alice", role: "user", disabled: false, mustChangePassword: false, canCreateProjects: false, createdAt: "2026-10-21", avatarStyle: null };
let root: Root;
let host: HTMLDivElement;
const styleTrigger = () => host.querySelector<HTMLButtonElement>(".avatar-style-trigger")!;
const searchInput = () => document.querySelector<HTMLInputElement>('.avatar-style-search input')!;
const styleOptions = () => [...document.querySelectorAll<HTMLButtonElement>('.avatar-style-options [role="option"]')];
const searchStyles = async (value: string) => act(async () => {
  const input = searchInput();
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
});
const chooseStyle = async (name: string) => {
  await act(async () => styleTrigger().click());
  await act(async () => styleOptions().find((option) => option.textContent === name)!.click());
};
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  await i18n.changeLanguage("en");
  vi.mocked(api).mockReset();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

describe("shared user avatars", () => {
  it("uses display-name initials by default without any image request", async () => {
    expect(avatarInitial(" 陈老师 ", "alice")).toBe("陈");
    expect(avatarInitial("", "alice")).toBe("A");
    await act(async () => root.render(createElement(UserAvatar, { userId: "a", name: "Alice", username: "alice" })));
    expect(host.textContent).toBe("A");
    expect(host.querySelector("img")).toBeNull();
    expect(userAvatarUrl(null, "lorelei")).toBeNull();
    expect(userAvatarUrl("a", "shapes")).toBeNull();
    expect(userAvatarUrl("a/b", "lorelei")).toBe("/api/users/a%2Fb/avatar.svg?style=lorelei&v=2");
  });

  it("shows the initial while loading and on failure, and retries after changing styles", async () => {
    const render = (style: string) => act(async () => root.render(createElement(UserAvatar, { userId: "a", name: "Alice", avatarStyle: style })));
    await render("lorelei");
    const image = host.querySelector("img")!;
    expect(image.getAttribute("src")).toBe("/api/users/a/avatar.svg?style=lorelei&v=2");
    expect(host.textContent).toBe("A");
    expect(image.style.visibility).toBe("hidden");
    await act(async () => image.dispatchEvent(new Event("load")));
    expect(host.textContent).toBe("");
    expect(image.style.visibility).toBe("visible");
    await act(async () => image.dispatchEvent(new Event("error")));
    expect(host.querySelector("img")).toBeNull();
    expect(host.textContent).toBe("A");
    await render("pixel-art"); await render("lorelei");
    expect(host.querySelector("img")).not.toBeNull();
  });
});

describe("avatar selection", () => {
  it("lists alphabetic Characters names and requests only the selected preview without saving", async () => {
    await act(async () => root.render(createElement(AvatarSettingsDialog, { user, onClose: vi.fn(), onSaved: vi.fn() })));
    expect(styleTrigger().textContent).toBe(i18n.t("account.avatarDefault"));
    expect(host.querySelector("img")).toBeNull();
    await act(async () => styleTrigger().click());
    expect(styleOptions().map((option) => option.textContent)).toEqual([i18n.t("account.avatarDefault"), ...AVATAR_STYLES.map((value) => value.split("-").map((word) => word[0].toUpperCase() + word.slice(1)).join(" "))]);
    expect(AVATAR_STYLES).toEqual([...AVATAR_STYLES].sort());
    expect(styleOptions()[0].getAttribute("aria-selected")).toBe("true");
    await act(async () => styleOptions().find((option) => option.textContent === "Lorelei")!.click());
    expect(document.querySelector('[role="listbox"]')).toBeNull();
    expect(host.querySelectorAll("img")).toHaveLength(1);
    expect(host.querySelector("img")?.getAttribute("src")).toBe("/api/users/a/avatar.svg?style=lorelei&v=2&preview=1");
    await chooseStyle("Pixel Art");
    expect(host.querySelectorAll("img")).toHaveLength(1);
    expect(host.querySelector("img")?.getAttribute("src")).toBe("/api/users/a/avatar.svg?style=pixel-art&v=2&preview=1");
    expect(host.querySelector("a")?.href).toBe("https://www.dicebear.com/styles/");
    expect(vi.mocked(api)).not.toHaveBeenCalled();
    await chooseStyle(i18n.t("account.avatarDefault"));
    expect(host.querySelector("img")).toBeNull();
  });

  it("filters by name, supports keyboard selection, and resets search on reopening", async () => {
    await act(async () => root.render(createElement(AvatarSettingsDialog, { user, onClose: vi.fn(), onSaved: vi.fn() })));
    await act(async () => styleTrigger().dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    const input = searchInput();
    expect(document.activeElement).toBe(input);
    await searchStyles("PIXEL-ART");
    expect(styleOptions().map((option) => option.textContent)).toEqual(["Pixel Art", "Pixel Art Neutral"]);
    expect(document.getElementById(input.getAttribute("aria-activedescendant")!)?.textContent).toBe("Pixel Art");
    await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    expect(document.getElementById(input.getAttribute("aria-activedescendant")!)?.textContent).toBe("Pixel Art Neutral");
    await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(styleTrigger().textContent).toBe("Pixel Art Neutral");
    expect(host.querySelector("img")?.getAttribute("src")).toContain("style=pixel-art-neutral");
    await act(async () => styleTrigger().click());
    expect(searchInput().value).toBe("");
    expect(styleOptions()).toHaveLength(AVATAR_STYLES.length + 1);
    expect(styleOptions().find((option) => option.getAttribute("aria-selected") === "true")?.textContent).toBe("Pixel Art Neutral");
    await act(async () => styleTrigger().click());
    expect(document.querySelector('[role="listbox"]')).toBeNull();
    // Radix returns focus after the popover's deferred unmount cleanup.
    await vi.waitFor(() => expect(document.activeElement).toBe(styleTrigger()));
    expect(api).not.toHaveBeenCalled();
  });

  it("shows an empty search state without changing the saved choice or preview", async () => {
    await act(async () => root.render(createElement(AvatarSettingsDialog, { user: { ...user, avatarStyle: "lorelei" }, onClose: vi.fn(), onSaved: vi.fn() })));
    await act(async () => styleTrigger().click());
    const input = searchInput();
    await searchStyles("not-a-style");
    expect(styleOptions()).toHaveLength(0);
    expect(document.querySelector('.avatar-style-empty[role="status"]')?.textContent).toBe(i18n.t("account.avatarNoMatches"));
    expect(input.hasAttribute("aria-activedescendant")).toBe(false);
    await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(styleTrigger().textContent).toBe("Lorelei");
    expect(host.querySelectorAll("img")).toHaveLength(1);
    expect(api).not.toHaveBeenCalled();
  });

  it("prevents duplicate saves and keeps failures inside the dialog without losing the selection", async () => {
    let fail!: (reason: Error) => void;
    vi.mocked(api).mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
    const onSaved = vi.fn(); const onClose = vi.fn();
    await act(async () => root.render(createElement(AvatarSettingsDialog, { user, onClose, onSaved })));
    await chooseStyle("Adventurer");
    const save = [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === i18n.t("common.save"))!;
    await act(async () => { save.click(); save.click(); });
    expect(api).toHaveBeenCalledTimes(1);
    expect(save.disabled).toBe(true);
    expect(styleTrigger().disabled).toBe(true);
    expect(document.querySelector('[role="listbox"]')).toBeNull();
    await act(async () => fail(new Error("Unable to save avatar")));
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("Unable to save avatar");
    expect(onClose).not.toHaveBeenCalled(); expect(onSaved).not.toHaveBeenCalled();
    expect(styleTrigger().textContent).toBe("Adventurer");
    expect(save.disabled).toBe(false);
    const updated = { ...user, avatarStyle: "adventurer" };
    vi.mocked(api).mockResolvedValueOnce({ user: updated });
    await act(async () => save.click());
    expect(api).toHaveBeenLastCalledWith("/api/me/avatar", { method: "PUT", body: JSON.stringify({ style: "adventurer" }) });
    expect(onSaved).toHaveBeenCalledWith(updated);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
