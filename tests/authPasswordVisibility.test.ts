// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Login, ChangePassword } from "../src/client/pages/AuthPages";
import { api } from "../src/client/api";
import i18n from "../src/client/i18n";
import type { SiteConfig, User } from "../src/client/types";

vi.mock("../src/client/api", async (original) => ({ ...await original<typeof import("../src/client/api")>(), api: vi.fn() }));
const site = { siteName: "TexLite", minPasswordLength: 8, adminEmail: "" } as SiteConfig;
let root: Root, host: HTMLDivElement;
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks(); await i18n.changeLanguage("en");
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

it.each(["login", "change"])("toggles each %s password independently without changing its value or submitting the form", async page => {
  await act(async () => root.render(page === "login"
    ? createElement(Login, { site, onLogin: vi.fn() })
    : createElement(ChangePassword, { site, user: { mustChangePassword: true } as User, onChanged: vi.fn() })));
  const fields = [...host.querySelectorAll<HTMLInputElement>(".auth-password-input input")];
  expect(fields).toHaveLength(page === "login" ? 1 : 3);
  for (const field of fields) {
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => { setValue.call(field, "secret-password"); field.dispatchEvent(new Event("input", { bubbles: true })); });
    const toggle = field.parentElement!.querySelector<HTMLButtonElement>("button")!;
    expect(field.type).toBe("password");
    expect(toggle.getAttribute("aria-label")).toBe("Show password");
    await act(async () => toggle.click());
    expect(field.type).toBe("text"); expect(field.value).toBe("secret-password");
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(toggle.getAttribute("aria-label")).toBe("Hide password");
    expect(fields.filter(other => other !== field).every(other => other.type === "password")).toBe(true);
    await act(async () => toggle.click());
    expect(field.type).toBe("password"); expect(field.value).toBe("secret-password");
  }
  expect(api).not.toHaveBeenCalled();
});
