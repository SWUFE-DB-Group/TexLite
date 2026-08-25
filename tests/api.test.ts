import { afterEach, describe, expect, it, vi } from "vitest";
import { api, ApiError } from "../src/client/api";

describe("client API session handling", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
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
});
