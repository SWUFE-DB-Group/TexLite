import { describe, expect, it } from "vitest";
import { hashPassword, MIN_PASSWORD_LENGTH, verifyPassword } from "../src/server/security.js";
import { safeRelativePath } from "../src/server/files.js";

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
    expect(() => safeRelativePath(".git/config")).toThrow("保留目录");
    expect(() => safeRelativePath("archive/.GIT/hooks/pre-commit")).toThrow("保留目录");
  });
});
