import { afterEach, describe, expect, it, vi } from "vitest";
import { api, apiUpload, ApiError } from "../src/client/api";
import i18n from "../src/client/i18n";

describe("client API session handling", () => {
  afterEach(async () => {
    vi.unstubAllGlobals();
    await i18n.changeLanguage("en");
  });

  it("sends the selected Traditional Chinese locale to the server", async () => {
    await i18n.changeLanguage("zh-Hant");
    const fetchMock = vi.fn(async (_url: string, _options?: RequestInit) => Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    await api("/api/projects");
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get("Accept-Language")).toBe("zh-Hant");
    await api("/api/projects", { headers: { "Accept-Language": "en" } });
    expect(new Headers(fetchMock.mock.calls[1]?.[1]?.headers).get("Accept-Language")).toBe("en");
  });

  it("also sends Traditional Chinese for ZIP uploads", async () => {
    await i18n.changeLanguage("zh-Hant");
    const headers = new Headers();
    class UploadRequest extends EventTarget {
      upload = new EventTarget();
      status = 200;
      responseText = '{"ok":true}';
      open() {}
      setRequestHeader(name: string, value: string) { headers.set(name, value); }
      getResponseHeader() { return "application/json"; }
      send() { this.dispatchEvent(new Event("load")); }
    }
    vi.stubGlobal("XMLHttpRequest", UploadRequest);
    await expect(apiUpload("/api/projects/import", new FormData())).resolves.toEqual({ ok: true });
    expect(headers.get("Accept-Language")).toBe("zh-Hant");
  });

  it("keeps speculative unauthorized requests from changing the route", async () => {
    const windowTarget = new EventTarget();
    const dispatch = vi.spyOn(windowTarget, "dispatchEvent");
    vi.stubGlobal("window", windowTarget);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ code: "AUTH_REQUIRED" }, { status: 401 })));

    await expect(api("/api/projects/project-1", { suppressSessionExpired: true }))
      .rejects.toBeInstanceOf(ApiError);

    expect(dispatch).not.toHaveBeenCalled();
  });

  it("still reports unauthorized requests that require an authenticated route", async () => {
    const windowTarget = new EventTarget();
    const dispatch = vi.spyOn(windowTarget, "dispatchEvent");
    vi.stubGlobal("window", windowTarget);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ code: "AUTH_REQUIRED" }, { status: 401 })));

    await expect(api("/api/projects/project-1")).rejects.toBeInstanceOf(ApiError);

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0]?.[0]).toBeInstanceOf(Event);
  });

  it("turns transport failures into a recoverable API error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));

    await expect(api("/api/projects/project-1"))
      .rejects.toMatchObject({ name: "Error", status: 0, code: "NETWORK_ERROR" });
  });

  it("turns malformed JSON responses into a recoverable API error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not json", {
      status: 200, headers: { "content-type": "application/json" }
    })));

    await expect(api("/api/projects/project-1"))
      .rejects.toMatchObject({ name: "Error", status: 200, code: "INVALID_RESPONSE" });
  });

  it.each(["en", "zh", "zh-Hant"])("localizes the outdated-client refresh hint in %s without reloading automatically", async (locale) => {
    await i18n.changeLanguage(locale);
    const windowTarget = new EventTarget();
    const dispatch = vi.spyOn(windowTarget, "dispatchEvent");
    vi.stubGlobal("window", windowTarget);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ code: "CLIENT_UPDATE_REQUIRED", error: "Server fallback" }, { status: 409 })));
    await expect(api("/api/projects/project-1/spellcheck", { method: "POST", body: "{}" })).rejects.toMatchObject({
      status: 409, code: "CLIENT_UPDATE_REQUIRED", message: i18n.t("errors.codes.CLIENT_UPDATE_REQUIRED")
    });
    expect(i18n.exists("errors.codes.CLIENT_UPDATE_REQUIRED")).toBe(true);
    expect(dispatch).not.toHaveBeenCalled();
  });
});
