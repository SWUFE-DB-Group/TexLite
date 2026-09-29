import { describe, expect, it } from "vitest";
import { classifyGitPushFailure } from "../src/server/git.js";

describe("GitHub push authentication diagnostics", () => {
  it("uses one token message for authentication and permission failures", () => {
    expect(classifyGitPushFailure("remote: Invalid username or token.\nfatal: Authentication failed")).toBe("GIT_TOKEN_REJECTED");
    expect(classifyGitPushFailure("remote: Write access to repository not granted.\nfatal: unable to access: HTTP 403")).toBe("GIT_TOKEN_REJECTED");
  });

  it("also handles SSO-related rejection and leaves unrelated Git failures generic", () => {
    expect(classifyGitPushFailure("remote: SAML SSO authorization required")).toBe("GIT_TOKEN_REJECTED");
    expect(classifyGitPushFailure("fatal: remote end hung up unexpectedly")).toBeNull();
  });
});
