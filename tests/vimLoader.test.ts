import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => { vi.doUnmock("../src/client/vimSupport"); vi.resetModules(); });

describe("lazy Vim support", () => {
  it("does not initialize Vim until requested, then shares initialization across callers", async () => {
    const moduleFactory = vi.fn(() => ({ createVimExtension: vi.fn(), watchVimStatus: vi.fn() }));
    vi.doMock("../src/client/vimSupport", moduleFactory);
    const { loadVimSupport } = await import("../src/client/vimLoader");
    expect(moduleFactory).not.toHaveBeenCalled();
    const first = loadVimSupport(), second = loadVimSupport();
    expect(first).toBe(second);
    await Promise.all([first, second]);
    expect(await loadVimSupport()).toBe(await first);
    expect(moduleFactory).toHaveBeenCalledTimes(1);
  });

  it("clears an unsuccessful import so that the next enable attempt can retry", async () => {
    const moduleFactory = vi.fn()
      .mockRejectedValueOnce(new Error("Disconnected"))
      .mockResolvedValue({ createVimExtension: vi.fn(), watchVimStatus: vi.fn() });
    vi.doMock("../src/client/vimSupport", moduleFactory);
    const { loadVimSupport } = await import("../src/client/vimLoader");
    await expect(loadVimSupport()).rejects.toThrow();
    await expect(loadVimSupport()).resolves.toHaveProperty("createVimExtension");
    expect(moduleFactory).toHaveBeenCalledTimes(2);
  });
});
