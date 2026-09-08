import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sourceHash } from "../src/client/sourceHash.js";

describe("source revision fingerprints", () => {
  it("uses the same UTF-8 SHA-256 value as the server", () => {
    const source = "A Unicode source: 中文, café, and \\section{Results}.\n";
    expect(sourceHash(source)).toBe(createHash("sha256").update(source, "utf8").digest("hex"));
  });
});
