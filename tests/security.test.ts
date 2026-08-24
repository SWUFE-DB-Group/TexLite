import { describe, expect, it } from "vitest";
import type { FastifyRequest } from "fastify";
import { hashPassword, MIN_PASSWORD_LENGTH, verifyPassword, LoginRateLimiter } from "../src/server/security.js";
import { safeRelativePath } from "../src/server/files.js";
import { clearCurrentUserCache, currentUser } from "../src/server/auth.js";

describe("security helpers", () => {
  it("hashes and verifies passwords", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(hash).not.toContain("correct horse");
    await expect(verifyPassword("correct horse battery staple", hash)).resolves.toBe(true);
    await expect(verifyPassword("wrong password", hash)).resolves.toBe(false);
  });

  it("requires passwords to contain at least eight characters", async () => {
    expect(MIN_PASSWORD_LENGTH).toBe(8);
    await expect(hashPassword("1234567")).rejects.toThrow("8");
    await expect(hashPassword("12345678")).resolves.toMatch(/^scrypt\$/);
  });

  it("rejects paths that escape the project", () => {
    expect(safeRelativePath("chapters/intro.tex")).toBe("chapters/intro.tex");
    expect(() => safeRelativePath("../../etc/passwd")).toThrow();
    expect(() => safeRelativePath("/etc/passwd")).toThrow();
    expect(() => safeRelativePath(".git/config")).toThrow("reserved");
    expect(() => safeRelativePath("archive/.GIT/hooks/pre-commit")).toThrow("reserved");
  });

  it("memoizes currentUser on repeated calls for the same request object", () => {
    let prepareCalls = 0;
    const mockDb = {
      prepare(_sql: string) {
        prepareCalls += 1;
        return {
          get() {
            return { id: "user-1", username: "admin", role: "admin", disabled: 0 };
          }
        };
      }
    } as unknown as Parameters<typeof currentUser>[1];

    const fakeRequest = {
      cookies: { texlite_session: "dummy-session-token" }
    } as unknown as FastifyRequest;

    const first = currentUser(fakeRequest, mockDb);
    expect(first).toEqual({ id: "user-1", username: "admin", role: "admin", disabled: 0 });
    expect(prepareCalls).toBe(1);

    const second = currentUser(fakeRequest, mockDb);
    expect(second).toBe(first);
    expect(prepareCalls).toBe(1);

    clearCurrentUserCache(fakeRequest);
    const third = currentUser(fakeRequest, mockDb);
    expect(third).toEqual(first);
    expect(prepareCalls).toBe(2);
  });

  it("limits consecutive failed login attempts and locks out after threshold", () => {
    const limiter = new LoginRateLimiter({ maxAttempts: 3, windowMs: 1000, lockoutMs: 2000 });
    const key = "127.0.0.1:testuser";

    expect(limiter.isLocked(key)).toBe(false);

    const first = limiter.recordFailure(key);
    expect(first.locked).toBe(false);
    expect(first.remainingAttempts).toBe(2);
    expect(limiter.isLocked(key)).toBe(false);

    const second = limiter.recordFailure(key);
    expect(second.locked).toBe(false);
    expect(second.remainingAttempts).toBe(1);
    expect(limiter.isLocked(key)).toBe(false);

    const third = limiter.recordFailure(key);
    expect(third.locked).toBe(true);
    expect(third.remainingAttempts).toBe(0);
    expect(third.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect(limiter.isLocked(key)).toBe(true);

    limiter.reset(key);
    expect(limiter.isLocked(key)).toBe(false);
  });
});
